// x402 pay-per-job (option X1, docs/x402-decision.md). INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED. Capped launch:
// the escrow contract (contracts/src/SparecycleX402Escrow.sol) limits each payment, the total held and each payer per
// epoch. New payments are accepted only with X402_ENABLED=1, a complete configuration and a passing on-chain preflight
// (x402Ready). With it off no route changes: every request answers exactly as before. Escrows already funded are
// settled whatever the flag says (each with its own stored escrow address), so switching x402 off never strands one.
//
//   402      POST /v1/chat/completions or /v1/images/generations with no Authorization header and no PAYMENT-SIGNATURE
//            -> 402 with PAYMENT-REQUIRED (x402 v2): one `exact` requirement on this chain, amount = the request's work
//            units x X402_PRICE_PER_UNIT (the jobPriceWei rule, in the asset's atomic units), payTo = the escrow, the
//            asset's EIP-712 name/version, and a `sparecycle-escrow` extension that says how the money is held.
//            Told apart from the prepaid-balance `402 insufficient_balance` by that header and the codes
//            `x402_payment_required` / `x402_payment_rejected`. Not offered when the job is above the escrow's per-job
//            cap (400 x402_amount_over_cap) or funding is paused (503 x402_paused).
//   pay      the client retries with PAYMENT-SIGNATURE (an EIP-3009 TransferWithAuthorization to the escrow). The
//            facilitator verifies it and settles it INTO the escrow: SparecycleX402Escrow.fund() from the scheduler key,
//            under escrowId = keccak256(abi.encode(jobId, salt)). By default the facilitator is this scheduler itself
//            (LocalFacilitator): the third-party facilitators that list Robinhood Chain settle `exact` by paying payTo
//            directly, which would put the money into the escrow contract without an escrow record. X402_FACILITATOR_URL
//            adds a third party's /verify in front of the local checks (RemoteVerifyFacilitator; leave it unset on
//            mainnet: it adds no check and shows the signed authorization to a third party).
//            The job is queued only after the funding transaction succeeded. The answer carries PAYMENT-RESPONSE and
//            the job's read secret (the only API credential an x402 payer has; the paying wallet can also sign in).
//            A payment that was used already answers one uniform 409 payment_used (no job id, no body comparison), so
//            the public funding calldata cannot be replayed to probe prompts.
//   verdict  settleX402() (a 15 s timer): agreed -> escrow.forward (95% to the pot; with the ETH pot of today, to the
//            Safe-set forwardTo for conversion; 5% to the treasury). Disagreed, expired, rejected, a payment whose job
//            could not be queued, or a deadline passed -> escrow.refund. Each step is stored before and after the
//            transaction and re-read from the chain, so a crash never forwards or refunds twice (the contract refuses
//            a second settlement anyway). A funding with an unknown outcome stays 'funding' until the chain says what
//            happened: escrow held -> refunded (no job was queued); authorization still unused after validBefore ->
//            failed (it can never land).
//   epoch    each epoch close puts the escrows that reached an outcome into that epoch's x402 tree (salted leaves,
//            src/lib/x402.ts X402_LEAF_RULE), served with the epoch's charges; the payer's receipt carries the salt and
//            the proof. Each outcome is also on-chain as the escrow's Funded / Forwarded / Refunded events.
import {
  createWalletClient,
  domainSeparator,
  getAddress,
  http,
  isAddress,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { sparecycleRewardsAbi } from "@/contracts/sparecycleRewards";
import { eip3009Abi, ESCROW_STATE, x402EscrowAbi, type EscrowState } from "@/contracts/x402Escrow";
import { publicClient, targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { jobPriceWei } from "@/lib/job-payment";
import { newLeafSalt } from "@/lib/job-receipt";
import { buildTree, getProof } from "@/lib/merkle";
import { needs, sha256Hex, workUnits, type JobRequest } from "@/lib/protocol";
import {
  assetDomain,
  authorizationMessage,
  caip2,
  decodeX402Header,
  encodeX402Header,
  escrowIdOf,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_HASH_RULE,
  X402_LEAF_OUTCOME,
  X402_LEAF_RULE,
  X402_LEAF_VERDICT,
  X402_VERSION,
  x402LeafOf,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  type X402LeafEntry,
  type X402LeafOutcome,
  type X402LeafVerdict,
} from "@/lib/x402";
import { requestHost } from "./auth";
import { describeChainError, schedulerAccount, sendAsScheduler } from "./chain-io";
import { getDb, nowSec, randomHex, tx } from "./db";
import { POLICY } from "./env";
import { ApiError } from "./http";
import { assertPairReachable } from "./capacity";
import { poolStartInfo } from "./gpu-pool";
import { assertCanQueue, expireStaleJobs, submitJob } from "./jobs";
import { limitBucket, takeHourly } from "./limits";

/** maxTimeoutSeconds of the requirement when X402_MAX_TIMEOUT_SECONDS is unset: the authorization only has to last until the escrow is funded. */
export const X402_DEFAULT_MAX_TIMEOUT_SECONDS = 300;
/** An authorization must stay valid at least this long after it arrives: time to send and mine the funding. */
export const X402_MIN_VALIDITY_SECONDS = 30;
/** Clock slack on top of maxTimeoutSeconds for the latest validBefore accepted. */
export const X402_VALID_BEFORE_SLACK_SECONDS = 60;
export const X402_SETTLE_TICK_MS = 15_000;
/** A funding attempt with no outcome after this long is resolved from the chain by the settle tick. */
export const X402_FUNDING_STALE_SECONDS = 300;
/** A sent forward / refund is sent again only when the escrow is still held this long after. */
export const X402_RESEND_AFTER_SECONDS = 180;
/** Payment attempts (a PAYMENT-SIGNATURE that is checked against the chain) per IP per hour. Default, not yet confirmed by Fabio. */
export const X402_PAYMENTS_PER_IP_HOUR = 300;
/** The escrow's settle window must cover the job TTL plus this margin, or x402 stays off (agreed jobs would be refunded). */
export const X402_SETTLE_MARGIN_SECONDS = 3600;
/** How long a preflight result (escrow config, caps, pause) is reused. */
export const X402_PREFLIGHT_TTL_MS = 60_000;
const REMOTE_VERIFY_TIMEOUT_MS = 10_000;

// ---- Configuration -------------------------------------------------------------------------------------------------

export type X402Config = {
  escrow: Address;
  asset: Address;
  assetName: string;
  assetVersion: string;
  /** Asset atomic units per work unit. */
  pricePerUnit: bigint;
  maxTimeoutSeconds: number;
  chainId: number;
  network: string;
  facilitatorUrl: string | null;
};

const str = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);
const addr = (v: string | undefined): Address | null => {
  const s = str(v);
  return s && isAddress(s) ? getAddress(s) : null;
};
let warned = false;

/**
 * The x402 settings for new payments, or null = x402 is off. On only with X402_ENABLED=1 and every value set:
 * X402_ESCROW_ADDRESS, X402_ASSET_ADDRESS, X402_ASSET_NAME / X402_ASSET_VERSION (the asset's EIP-712 domain),
 * X402_PRICE_PER_UNIT (asset units per work unit, > 0) and SCHEDULER_SIGNER_KEY. Read on every call.
 */
export function x402Config(): X402Config | null {
  if (process.env.X402_ENABLED !== "1") return null;
  const escrow = addr(process.env.X402_ESCROW_ADDRESS);
  const asset = addr(process.env.X402_ASSET_ADDRESS);
  const assetName = str(process.env.X402_ASSET_NAME);
  const assetVersion = str(process.env.X402_ASSET_VERSION);
  const priceRaw = str(process.env.X402_PRICE_PER_UNIT);
  const pricePerUnit = priceRaw && /^\d{1,30}$/.test(priceRaw) ? BigInt(priceRaw) : 0n;
  const t = Number(str(process.env.X402_MAX_TIMEOUT_SECONDS) ?? X402_DEFAULT_MAX_TIMEOUT_SECONDS);
  const maxTimeoutSeconds = Number.isInteger(t) && t >= 60 && t <= 3600 ? t : X402_DEFAULT_MAX_TIMEOUT_SECONDS;
  const facilitatorUrl = str(process.env.X402_FACILITATOR_URL);
  if (!escrow || !asset || !assetName || !assetVersion || pricePerUnit <= 0n || !schedulerAccount()) {
    if (!warned) {
      warned = true;
      console.error(
        "[sparecycle] X402_ENABLED=1 but x402 stays off: set X402_ESCROW_ADDRESS, X402_ASSET_ADDRESS, X402_ASSET_NAME, X402_ASSET_VERSION, X402_PRICE_PER_UNIT and SCHEDULER_SIGNER_KEY",
      );
    }
    return null;
  }
  return {
    escrow,
    asset,
    assetName,
    assetVersion,
    pricePerUnit,
    maxTimeoutSeconds,
    chainId: targetChain.id,
    network: caip2(targetChain.id),
    facilitatorUrl: facilitatorUrl && /^https:\/\//.test(facilitatorUrl) ? facilitatorUrl.replace(/\/$/, "") : null,
  };
}

/** True when this request takes the x402 path: x402 is on and the request carries no Authorization header at all. */
export const x402Applies = (req: Request) => x402Config() !== null && !req.headers.has("authorization");

/** True when job `id` was paid with x402 (it has an escrow record). */
export const isX402Job = (id: string) => getDb().prepare("SELECT 1 FROM x402_escrows WHERE job_id = ?").get(id) !== undefined;

// ---- Chain access (an interface, so tests can run without a chain) ---------------------------------------------------

export type FundArgs = {
  escrowId: Hex;
  payer: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
};

/** What the preflight reads: the escrow's wiring and launch state. */
export type EscrowInfo = {
  asset: Address;
  rewards: Address;
  rewardsScheduler: Address;
  settleWindow: number;
  maxPerJob: bigint;
  fundingPaused: boolean;
  assetDomainSeparator: Hex;
};

/** One escrow contract and its asset. Every send goes through the scheduler key. */
export interface EscrowChain {
  /** Sends fund(), waits for the receipt; `onSent` gets the hash first. Throws X402Reverted (nothing moved) or X402Uncertain. */
  fund(a: FundArgs, onSent: (tx: Hex) => void): Promise<{ tx: Hex; deadline: number }>;
  forward(escrowId: Hex, onSent: (tx: Hex) => void): Promise<Hex>;
  refund(escrowId: Hex, onSent: (tx: Hex) => void): Promise<Hex>;
  escrowState(escrowId: Hex): Promise<{ state: EscrowState; deadline: number; amount: bigint; payer: Address }>;
  authorizationUsed(payer: Address, nonce: Hex): Promise<boolean>;
  balanceOf(payer: Address): Promise<bigint>;
  info(): Promise<EscrowInfo>;
}

/** The transaction was not sent (its simulation failed) or was mined and reverted: nothing moved. */
export class X402Reverted extends Error {}
/** The transaction may have been broadcast and its outcome is unknown (an RPC error or timeout after the send). */
export class X402Uncertain extends Error {}

function viemChain(escrow: Address, asset: Address): EscrowChain {
  const account = schedulerAccount();
  if (!account) throw new Error("SCHEDULER_SIGNER_KEY not set");
  const wallet = createWalletClient({ account, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) });
  const send = async (functionName: "fund" | "forward" | "refund", args: readonly unknown[], onSent: (tx: Hex) => void) => {
    let request: unknown;
    try {
      ({ request } = await publicClient.simulateContract({ account, address: escrow, abi: x402EscrowAbi, functionName, args } as never));
    } catch (e) {
      throw new X402Reverted(describeChainError(e)); // simulation failed: nothing was sent
    }
    let hash: Hex;
    try {
      hash = await sendAsScheduler(() => wallet.writeContract(request as never));
    } catch (e) {
      throw new X402Uncertain(describeChainError(e)); // an RPC error here may still have broadcast it
    }
    onSent(hash);
    let status: string;
    try {
      status = (await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })).status;
    } catch (e) {
      throw new X402Uncertain(`no receipt for ${hash}: ${describeChainError(e)}`);
    }
    if (status !== "success") throw new X402Reverted(`transaction ${hash} reverted`);
    return hash;
  };
  const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const chain: EscrowChain = {
    async fund(a, onSent) {
      const txHash = await send("fund", [a.escrowId, a.payer, a.amount, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s], onSent);
      return { tx: txHash, deadline: (await chain.escrowState(a.escrowId)).deadline };
    },
    forward: (id, onSent) => send("forward", [id], onSent),
    refund: (id, onSent) => send("refund", [id], onSent),
    async escrowState(id) {
      const [payer, deadline, state, amount] = await read<[Address, bigint, number, bigint]>(escrow, x402EscrowAbi, "escrows", [id]);
      return { payer, deadline: Number(deadline), state: ESCROW_STATE[state] ?? "none", amount };
    },
    authorizationUsed: (payer, nonce) => read<boolean>(asset, eip3009Abi, "authorizationState", [payer, nonce]),
    balanceOf: (payer) => read<bigint>(asset, eip3009Abi, "balanceOf", [payer]),
    async info() {
      const [a, rewards, settleWindow, maxPerJob, fundingPaused, sep] = await Promise.all([
        read<Address>(escrow, x402EscrowAbi, "asset"),
        read<Address>(escrow, x402EscrowAbi, "rewards"),
        read<bigint>(escrow, x402EscrowAbi, "settleWindow"),
        read<bigint>(escrow, x402EscrowAbi, "maxPerJob"),
        read<boolean>(escrow, x402EscrowAbi, "fundingPaused"),
        read<Hex>(asset, eip3009Abi, "DOMAIN_SEPARATOR"),
      ]);
      const rewardsScheduler = await read<Address>(rewards, sparecycleRewardsAbi, "scheduler");
      return { asset: a, rewards, rewardsScheduler, settleWindow: Number(settleWindow), maxPerJob, fundingPaused, assetDomainSeparator: sep };
    },
  };
  return chain;
}

// ---- Facilitator --------------------------------------------------------------------------------------------------

export type VerifyResult = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: Address };
export type SettleResult = SettleResponse & { deadline?: number };

/**
 * The x402 facilitator role (spec §7: verify, settle), adapted to an escrow: `settle` must move the payment into the
 * escrow under `escrowId`, never to payTo alone. LocalFacilitator does both on this scheduler; a third party can be
 * swapped in through this interface (X402_FACILITATOR_URL adds its /verify today).
 */
export interface X402Facilitator {
  readonly name: string;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements, escrow: { escrowId: Hex; onSent: (tx: Hex) => void }): Promise<SettleResult>;
}

const sameAddr = (a: unknown, b: string) => typeof a === "string" && isAddress(a) && a.toLowerCase() === b.toLowerCase();
const DIGITS = /^\d{1,78}$/;

/** The scheduler as its own facilitator: verifies the EIP-3009 authorization locally and funds the escrow itself. */
export class LocalFacilitator implements X402Facilitator {
  readonly name = "sparecycle-scheduler";
  private readonly chainId: number;
  private readonly chain: EscrowChain;
  constructor(chainId: number, chain: EscrowChain) {
    this.chainId = chainId;
    this.chain = chain;
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult> {
    const fail = (invalidReason: string, invalidMessage: string): VerifyResult => ({ isValid: false, invalidReason, invalidMessage });
    if (payload?.x402Version !== X402_VERSION) return fail("invalid_x402_version", `send x402Version ${X402_VERSION}`);
    const acc = payload.accepted;
    if (!acc || acc.scheme !== "exact") return fail("invalid_scheme", "only the exact scheme is accepted");
    if (acc.network !== req.network) return fail("invalid_network", `pay on ${req.network}`);
    if (!sameAddr(acc.asset, req.asset) || !sameAddr(acc.payTo, req.payTo) || acc.amount !== req.amount) {
      return fail("invalid_payment_requirements", "the payment is for other requirements: the price follows the request body, ask again");
    }
    const a = payload.payload?.authorization;
    const sig = payload.payload?.signature;
    if (
      !a ||
      !isAddress(a.from ?? "") ||
      !isAddress(a.to ?? "") ||
      ![a.value, a.validAfter, a.validBefore].every((x) => typeof x === "string" && DIGITS.test(x)) ||
      typeof a.nonce !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(a.nonce) ||
      typeof sig !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(sig)
    ) {
      return fail("invalid_payload", "payload needs signature (65 bytes) and authorization {from, to, value, validAfter, validBefore, nonce}");
    }
    if (!sameAddr(a.to, req.payTo)) return fail("invalid_exact_evm_payload_recipient_mismatch", "authorization.to must be the escrow (payTo)");
    if (BigInt(a.value) !== BigInt(req.amount)) return fail("invalid_exact_evm_payload_authorization_value_mismatch", `authorization.value must be ${req.amount}`);
    const now = BigInt(nowSec());
    if (BigInt(a.validAfter) >= now) return fail("invalid_exact_evm_payload_authorization_valid_after", "authorization is not valid yet");
    if (BigInt(a.validBefore) < now + BigInt(X402_MIN_VALIDITY_SECONDS)) {
      return fail("invalid_exact_evm_payload_authorization_valid_before", `authorization must stay valid for at least ${X402_MIN_VALIDITY_SECONDS} s`);
    }
    // A short-lived authorization: one that failed to fund cannot be used later (by anyone who saw it).
    if (BigInt(a.validBefore) > now + BigInt(req.maxTimeoutSeconds + X402_VALID_BEFORE_SLACK_SECONDS)) {
      return fail("invalid_exact_evm_payload_authorization_valid_before", `validBefore must be at most maxTimeoutSeconds (${req.maxTimeoutSeconds} s) ahead`);
    }
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: assetDomain(req, this.chainId),
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: authorizationMessage(a),
        signature: sig,
      });
    } catch {
      return fail("invalid_exact_evm_payload_signature", "signature could not be recovered");
    }
    if (signer.toLowerCase() !== a.from.toLowerCase()) return fail("invalid_exact_evm_payload_signature", "not signed by authorization.from");
    const from = getAddress(a.from);
    try {
      if (await this.chain.authorizationUsed(from, a.nonce as Hex)) return fail("invalid_transaction_state", "this authorization nonce was already used or cancelled");
      if ((await this.chain.balanceOf(from)) < BigInt(a.value)) return fail("insufficient_funds", "the payer's balance is below the amount");
    } catch (e) {
      return fail("unexpected_verify_error", `could not read the asset: ${describeChainError(e)}`);
    }
    return { isValid: true, payer: from };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements, escrow: { escrowId: Hex; onSent: (tx: Hex) => void }): Promise<SettleResult> {
    const a = payload.payload.authorization;
    const payer = getAddress(a.from);
    const p = parseSignature(payload.payload.signature);
    const v = p.v !== undefined ? Number(p.v) : p.yParity + 27;
    const sent: { tx: Hex | null } = { tx: null };
    try {
      const out = await this.chain.fund(
        {
          escrowId: escrow.escrowId,
          payer,
          amount: BigInt(a.value),
          validAfter: BigInt(a.validAfter),
          validBefore: BigInt(a.validBefore),
          nonce: a.nonce,
          v,
          r: p.r,
          s: p.s,
        },
        (h) => {
          sent.tx = h;
          escrow.onSent(h);
        },
      );
      return { success: true, transaction: out.tx, network: req.network, payer, amount: req.amount, deadline: out.deadline };
    } catch (e) {
      return {
        success: false,
        // Only a known non-send or revert is final; anything else may still land and is resolved from the chain later.
        errorReason: e instanceof X402Reverted ? "unexpected_settle_error" : "settlement_pending",
        errorMessage: describeChainError(e),
        transaction: sent.tx ?? "",
        network: req.network,
        payer,
      };
    }
  }
}

/**
 * A third-party facilitator's POST /verify (spec §7) after the local checks. Settlement stays local: a standard
 * `exact` settle pays payTo directly, which would put the money into the escrow contract without an escrow record.
 * The signed payload is sent to that third party: leave X402_FACILITATOR_URL unset on mainnet.
 */
export class RemoteVerifyFacilitator implements X402Facilitator {
  readonly name: string;
  private readonly url: string;
  private readonly local: LocalFacilitator;
  constructor(url: string, local: LocalFacilitator) {
    this.url = url;
    this.local = local;
    this.name = `remote-verify(${new URL(url).host})+sparecycle-scheduler`;
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult> {
    const mine = await this.local.verify(payload, requirements);
    if (!mine.isValid) return mine;
    try {
      const res = await fetch(`${this.url}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements }),
        signal: AbortSignal.timeout(REMOTE_VERIFY_TIMEOUT_MS),
      });
      const body = (await res.json()) as VerifyResult;
      if (!res.ok || body.isValid !== true) {
        return { isValid: false, invalidReason: body.invalidReason ?? "unexpected_verify_error", invalidMessage: body.invalidMessage ?? `facilitator answered ${res.status}` };
      }
      return mine;
    } catch (e) {
      return { isValid: false, invalidReason: "unexpected_verify_error", invalidMessage: `facilitator unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements, escrow: { escrowId: Hex; onSent: (tx: Hex) => void }) {
    return this.local.settle(payload, requirements, escrow);
  }
}

// Test seams: unit tests replace the chain and / or the facilitator (never set in the app).
const seams: { chain: EscrowChain | null; facilitator: X402Facilitator | null } = { chain: null, facilitator: null };
export function setX402TestSeams(s: { chain?: EscrowChain | null; facilitator?: X402Facilitator | null }) {
  if (s.chain !== undefined) seams.chain = s.chain;
  if (s.facilitator !== undefined) seams.facilitator = s.facilitator;
  preflight = null;
}
/** The chain access of one escrow contract (each stored escrow row names its own). */
const chainOf = (escrow: Address, asset: Address) => seams.chain ?? viemChain(escrow, asset);
function facilitatorOf(cfg: X402Config): X402Facilitator {
  if (seams.facilitator) return seams.facilitator;
  const local = new LocalFacilitator(cfg.chainId, chainOf(cfg.escrow, cfg.asset));
  return cfg.facilitatorUrl ? new RemoteVerifyFacilitator(cfg.facilitatorUrl, local) : local;
}

// ---- Preflight: the escrow on-chain must match the configuration ------------------------------------------------------

let preflight: { key: string; at: number; ok: boolean; reason: string | null; info: EscrowInfo | null } | null = null;

/**
 * Reads the escrow (cached X402_PREFLIGHT_TTL_MS) and checks it against the configuration: its asset is X402_ASSET_ADDRESS,
 * its reward contract is NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS (when set), that contract's scheduler is the signer key,
 * the asset's DOMAIN_SEPARATOR is the configured EIP-712 name / version on this chain, and the settle window covers the
 * job TTL plus X402_SETTLE_MARGIN_SECONDS. A mismatch keeps x402 from taking payments (503 x402_unavailable, logged).
 */
export async function x402Ready(cfg: X402Config): Promise<{ ok: boolean; reason: string | null; info: EscrowInfo | null }> {
  const key = `${cfg.escrow}|${cfg.asset}|${cfg.assetName}|${cfg.assetVersion}`;
  if (preflight && preflight.key === key && Date.now() - preflight.at < X402_PREFLIGHT_TTL_MS) return preflight;
  let ok = false;
  let reason: string | null = null;
  let info: EscrowInfo | null = null;
  try {
    info = await chainOf(cfg.escrow, cfg.asset).info();
    const signer = schedulerAccount()?.address ?? "";
    const sep = domainSeparator({ domain: { name: cfg.assetName, version: cfg.assetVersion, chainId: cfg.chainId, verifyingContract: cfg.asset } });
    if (!sameAddr(info.asset, cfg.asset)) reason = `escrow asset ${info.asset} is not X402_ASSET_ADDRESS`;
    else if (config.rewardContract && !sameAddr(info.rewards, config.rewardContract)) reason = `escrow reward contract ${info.rewards} is not this scheduler's`;
    else if (!sameAddr(info.rewardsScheduler, signer)) reason = "SCHEDULER_SIGNER_KEY is not the reward contract's scheduler";
    else if (info.assetDomainSeparator.toLowerCase() !== sep.toLowerCase()) reason = "X402_ASSET_NAME / X402_ASSET_VERSION do not match the asset's DOMAIN_SEPARATOR";
    else if (info.settleWindow < POLICY.jobTtlSeconds + X402_SETTLE_MARGIN_SECONDS) reason = `escrow settle window ${info.settleWindow} s is shorter than the job TTL plus ${X402_SETTLE_MARGIN_SECONDS} s`;
    else ok = true;
  } catch (e) {
    reason = `escrow unreadable: ${describeChainError(e)}`;
  }
  if (!ok && preflight?.reason !== reason) console.error(`[sparecycle] x402 preflight failed, not taking payments: ${reason}`);
  preflight = { key, at: Date.now(), ok, reason, info };
  return preflight;
}

// ---- The 402 answer ---------------------------------------------------------------------------------------------------

/** The absolute URL of a request as the client sent it (behind the hosting proxy). */
function resourceUrl(req: Request): string {
  const u = new URL(req.url);
  const proto = (req.headers.get("x-forwarded-proto") ?? u.protocol.replace(/:$/, "")).split(",")[0].trim() || "https";
  return `${proto}://${requestHost(req)}${u.pathname}`;
}

export function requirementsOf(cfg: X402Config, amount: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: amount.toString(),
    asset: cfg.asset,
    payTo: cfg.escrow,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { name: cfg.assetName, version: cfg.assetVersion, assetTransferMethod: "eip3009" },
  };
}

/** The PaymentRequired object for a job request (`error` set when a payment was sent and refused). */
export function paymentRequiredOf(req: Request, cfg: X402Config, request: JobRequest, error?: string): PaymentRequired {
  const amount = jobPriceWei(request, cfg.pricePerUnit);
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: {
      url: resourceUrl(req),
      description: `One ${request.kind} job on ${request.params.model}, run on two nodes of different owners; paid into an escrow, forwarded only if the two results agree, refunded otherwise.`,
      mimeType: "application/json",
      serviceName: "Sparecycle",
    },
    accepts: [requirementsOf(cfg, amount)],
    extensions: {
      "sparecycle-escrow": {
        info: {
          escrow: cfg.escrow,
          review: "internal review only, not externally audited; capped launch",
          workUnits: workUnits(request),
          pricePerWorkUnit: cfg.pricePerUnit.toString(),
          settlement:
            "The payment moves into the escrow before the job is queued. Two nodes agree: 95% goes to the node reward pot (sent to a Safe-controlled address for conversion, because the pot pays ETH) and 5% to the treasury. They do not agree, the job expires or is rejected: refunded to the payer. After the escrow's deadline anyone can refund it.",
          poll: "the create answer carries sparecycle.read_secret (given once): send it as Authorization: Bearer on the poll URL",
        },
        schema: { type: "object" },
      },
    },
  };
}

/** The 402 answer itself: OpenAI-shaped error body plus the PaymentRequired object, and the PAYMENT-REQUIRED header. */
export function paymentRequiredAnswer(pr: PaymentRequired, rejected?: { reason: string; message?: string }) {
  const message = rejected
    ? `Payment refused (${rejected.reason})${rejected.message ? `: ${rejected.message}` : ""}. Sign a new payment for the requirements in PAYMENT-REQUIRED.`
    : "Payment required: no API key was sent. Pay this job with x402 (the PAYMENT-REQUIRED header) or send a Sparecycle API key.";
  return {
    status: 402,
    headers: { "payment-required": encodeX402Header(pr) },
    body: {
      error: { message, type: "payment_required", param: null, code: rejected ? "x402_payment_rejected" : "x402_payment_required" },
      x402: pr,
    },
  };
}

// ---- Paying for a job -----------------------------------------------------------------------------------------------

type EscrowRow = {
  job_id: Hex;
  escrow_id: Hex;
  escrow_salt: Hex;
  payer: Address;
  escrow: Address;
  asset: Address;
  network: string;
  amount: string;
  auth_nonce: Hex;
  valid_before: number;
  surface: string;
  body_hash: string;
  response_format: string | null;
  status: "funding" | "held" | "forwarding" | "forwarded" | "refunding" | "refunded" | "failed";
  reason: string | null;
  deadline: number | null;
  fund_tx: Hex | null;
  settle_tx: Hex | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
  leaf_epoch: number | null;
};

export type X402Paid = { kind: "paid"; jobId: Hex; readSecret: string | null; format: string | null; paymentResponse: string };
export type X402Required = { kind: "required"; status: number; headers: Record<string, string>; body: unknown };

/** Payments being handled by a request of this process: the settle tick leaves their rows alone. */
const inFlight = new Set<string>();

/**
 * The x402 path of a create call: 402 without a payment; with a payment, verify, fund the escrow, queue the job.
 * `request` is the already validated job request (its work units set the price).
 */
export async function x402Pay(
  req: Request,
  request: JobRequest,
  o: { surface: "chat" | "images"; bodyText: string; format: string | null; ip: string },
): Promise<X402Paid | X402Required> {
  const cfg = x402Config();
  if (!cfg) throw new ApiError(503, "x402-off", "x402 is not enabled on this scheduler");
  // Serverless capacity guard first: no pair of machines with different owners -> 503 no-node-pair, and no payment is
  // asked for or taken (the same rule as every other create path, src/server/capacity.ts).
  assertPairReachable(needs(request).model, poolStartInfo());
  const ready = await x402Ready(cfg);
  if (!ready.ok || !ready.info) throw new ApiError(503, "x402-unavailable", "x402 payments are not available right now; use an API key");
  const pr = paymentRequiredOf(req, cfg, request);
  const requirements = pr.accepts[0];
  // Never offer a payment that the escrow would refuse.
  if (ready.info.fundingPaused) throw new ApiError(503, "x402-paused", "x402 payments are paused; use an API key");
  if (BigInt(requirements.amount) > ready.info.maxPerJob) {
    throw new ApiError(400, "x402-over-cap", `this job costs ${requirements.amount}, above the x402 per-job cap of ${ready.info.maxPerJob}: send a smaller job or use an API key`);
  }
  const required = (reason?: string, message?: string): X402Required => ({
    kind: "required",
    ...paymentRequiredAnswer(reason ? { ...pr, error: reason } : pr, reason ? { reason, message } : undefined),
  });

  const header = req.headers.get("payment-signature");
  if (!header) return required();
  takeHourly(limitBucket("x402-pay", o.ip), X402_PAYMENTS_PER_IP_HOUR, "x402 payment attempts"); // before any chain read
  let payload: PaymentPayload;
  try {
    payload = decodeX402Header<PaymentPayload>(header);
  } catch {
    return required("invalid_payload", "PAYMENT-SIGNATURE must be base64 JSON");
  }
  const a = payload?.payload?.authorization;
  // A payment seen before answers one uniform 409, whatever its state or body: the funding calldata is public, so a
  // replay must not tell anyone which request it paid for. (A failed attempt does not count: it may be retried.)
  if (a && typeof a.from === "string" && isAddress(a.from) && typeof a.nonce === "string") {
    const prior = getDb()
      .prepare("SELECT 1 FROM x402_escrows WHERE payer = ? AND auth_nonce = ? AND status <> 'failed'")
      .get(getAddress(a.from), a.nonce.toLowerCase());
    if (prior) throw paymentUsed();
  }

  const facilitator = facilitatorOf(cfg);
  const verdict = await facilitator.verify(payload, requirements);
  if (!verdict.isValid || !verdict.payer) return required(verdict.invalidReason ?? "invalid_payload", verdict.invalidMessage);
  const payer = verdict.payer;
  assertCanQueue(payer); // 429 / 503 before any money moves

  // Reserve the job id and the escrow id (one funding per payer at a time), then fund.
  const jobId = randomHex(32);
  const salt = randomHex(32);
  const escrowId = escrowIdOf(jobId, salt);
  const now = nowSec();
  try {
    getDb()
      .prepare(
        `INSERT INTO x402_escrows (job_id, escrow_id, escrow_salt, payer, escrow, asset, network, amount, auth_nonce, valid_before, surface,
           body_hash, response_format, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'funding', ?, ?)`,
      )
      .run(jobId, escrowId, salt, payer, cfg.escrow, cfg.asset, cfg.network, requirements.amount, a.nonce.toLowerCase(), Number(a.validBefore), o.surface, sha256Hex(o.bodyText), o.format, now, now);
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: x402_escrows\.payer/.test(e.message)) {
      throw new ApiError(409, "payment-in-progress", "another payment of this wallet is being processed; try again in a moment");
    }
    if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) throw paymentUsed();
    throw e;
  }
  inFlight.add(jobId);
  try {
    const settled = await facilitator.settle(payload, requirements, {
      escrowId,
      onSent: (h) => getDb().prepare("UPDATE x402_escrows SET fund_tx = ?, updated_at = ? WHERE job_id = ?").run(h, nowSec(), jobId),
    });
    if (!settled.success) {
      if (settled.errorReason === "settlement_pending") {
        // Maybe sent, outcome unknown: the settle tick reads the chain later and refunds it if it landed (no job was queued).
        getDb().prepare("UPDATE x402_escrows SET error = ?, updated_at = ? WHERE job_id = ?").run(settled.errorMessage ?? "pending", nowSec(), jobId);
        throw new ApiError(503, "payment-pending", "the escrow funding was sent but not confirmed; if it lands it is refunded, because no job was queued. Sign a new payment to retry.");
      }
      getDb().prepare("UPDATE x402_escrows SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?").run(settled.errorMessage ?? settled.errorReason ?? "failed", nowSec(), jobId);
      return required(settled.errorReason ?? "unexpected_settle_error", settled.errorMessage);
    }

    // The escrow holds the payment: queue the job and mark the escrow held in the same transaction. If anything else
    // already moved the row out of 'funding', the job is not queued.
    const held = (db: ReturnType<typeof getDb>, reason: string | null) =>
      Number(
        db
          .prepare("UPDATE x402_escrows SET status = 'held', reason = ?, fund_tx = ?, deadline = ?, error = NULL, updated_at = ? WHERE job_id = ? AND status = 'funding'")
          .run(reason, settled.transaction, settled.deadline ?? null, nowSec(), jobId).changes,
      );
    let readSecret: string | null = null;
    try {
      const job = await submitJob(request, o.ip, {
        x402: { payer, jobId },
        onInsert: (db) => {
          if (held(db, null) !== 1) throw new ApiError(409, "payment-refunded", "this payment was already settled without a job; sign a new one");
        },
      });
      readSecret = job.readSecret ?? null;
    } catch (e) {
      held(getDb(), "not-queued");
      inFlight.delete(jobId);
      await settleX402(jobId).catch(() => undefined); // refund now; the timer retries if this fails
      throw e;
    }
    const response: SettleResponse = { success: true, transaction: settled.transaction, network: cfg.network, payer, amount: requirements.amount };
    return { kind: "paid", jobId, readSecret, format: o.format, paymentResponse: encodeX402Header(response) };
  } finally {
    inFlight.delete(jobId);
  }
}

const paymentUsed = () =>
  new ApiError(409, "payment-used", "this payment was already used. A paid job's read secret is in its first answer; the paying wallet can also sign in to read it.");

/** The x402 block of a job's answers (payer-only views), or null for a job not paid with x402. */
export function x402PaymentInfo(jobId: string) {
  const r = getDb().prepare("SELECT * FROM x402_escrows WHERE job_id = ?").get(jobId) as EscrowRow | undefined;
  if (!r) return null;
  return {
    scheme: "exact",
    network: r.network,
    asset: r.asset,
    amount: r.amount,
    escrow: r.escrow,
    escrow_id: r.escrow_id,
    status: r.status,
    reason: r.reason,
    deadline: r.deadline,
    fund_tx: r.fund_tx,
    settle_tx: r.settle_tx,
  };
}

// ---- Settlement -----------------------------------------------------------------------------------------------------

type OpenRow = EscrowRow & { job_status: string | null };
let ticking = false;

/**
 * Forwards or refunds every escrow whose job reached an outcome, and resolves fundings and settlements left open by a
 * crash or a timeout. Runs whenever there are open escrows and the scheduler key is set, whether or not new x402
 * payments are accepted; each row uses its own escrow address. `onlyJob` limits it to one escrow (used right after a
 * payment whose job could not be queued). Returns a one-line summary; never throws for a chain error.
 */
export async function settleX402(onlyJob?: string): Promise<string> {
  if (!schedulerAccount()) return "x402: SCHEDULER_SIGNER_KEY not set";
  if (ticking && !onlyJob) return "x402 settlement already running";
  if (!onlyJob) ticking = true;
  try {
    const open = getDb()
      .prepare(
        `SELECT e.*, j.status AS job_status FROM x402_escrows e LEFT JOIN jobs j ON j.id = e.job_id
         WHERE e.status IN ('funding','held','forwarding','refunding') ${onlyJob ? "AND e.job_id = ?" : ""} ORDER BY e.created_at`,
      )
      .all(...(onlyJob ? [onlyJob] : [])) as OpenRow[];
    if (!open.length) return "nothing to settle";
    expireStaleJobs();
    const rows = getDb()
      .prepare(`SELECT e.*, j.status AS job_status FROM x402_escrows e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.job_id IN (${open.map(() => "?").join(",")}) ORDER BY e.created_at`)
      .all(...open.map((r) => r.job_id)) as OpenRow[];
    const out: string[] = [];
    for (const r of rows) {
      if (inFlight.has(r.job_id)) continue;
      try {
        const s = await settleRow(chainOf(r.escrow, r.asset), r);
        if (s) out.push(s);
      } catch (e) {
        getDb().prepare("UPDATE x402_escrows SET error = ? WHERE job_id = ?").run(describeChainError(e), r.job_id);
        out.push(`${r.job_id.slice(0, 10)}: ${describeChainError(e)}`);
      }
    }
    return out.length ? out.join("; ") : "nothing to settle";
  } finally {
    if (!onlyJob) ticking = false;
  }
}

const FINAL_JOB = ["agreed", "disagreed", "expired", "rejected"];

async function settleRow(chain: EscrowChain, r: OpenRow): Promise<string | null> {
  const now = nowSec();
  const id = r.job_id.slice(0, 10);
  const pastDeadline = r.deadline !== null && now > r.deadline;
  if (r.status === "funding") {
    if (r.created_at > now - X402_FUNDING_STALE_SECONDS) return null; // the paying request may still be running
    const st = await chain.escrowState(r.escrow_id);
    if (st.state === "forwarded" || st.state === "refunded") return finalize(r, st.state, null);
    if (st.state === "held") {
      // It landed, but no job was queued (the paying request died after the funding): give it back.
      setRow(r.job_id, { status: "held", reason: "not-queued", deadline: st.deadline });
      return act(chain, { ...r, deadline: st.deadline }, "refund", "not-queued");
    }
    if (await chain.authorizationUsed(r.payer, r.auth_nonce)) {
      setRow(r.job_id, {
        status: "failed",
        error: "the authorization was used outside the escrow's fund(): the amount is surplus in the escrow; the Safe can return it with recoverSurplus(asset, payer)",
      });
      return `${id}: authorization used outside fund() (surplus)`;
    }
    if (now > r.valid_before) {
      setRow(r.job_id, { status: "failed", error: "the funding never landed and the authorization has expired" });
      return `${id}: funding did not land`;
    }
    return null; // may still land: look again next tick
  }
  if (r.status === "held") {
    if (r.job_status === null) return act(chain, r, "refund", r.reason ?? "not-queued");
    if (r.job_status === "agreed") return pastDeadline ? act(chain, r, "refund", "deadline") : act(chain, r, "forward", "agreed");
    if (FINAL_JOB.includes(r.job_status)) return act(chain, r, "refund", r.job_status);
    return pastDeadline ? act(chain, r, "refund", "deadline") : null; // still running
  }
  // forwarding / refunding: a transaction was sent earlier
  const st = await chain.escrowState(r.escrow_id);
  if (st.state === "forwarded" || st.state === "refunded") return finalize(r, st.state, null);
  if (r.updated_at > now - X402_RESEND_AFTER_SECONDS) return null; // give the sent transaction time
  if (r.status === "forwarding" && pastDeadline) return act(chain, r, "refund", "deadline");
  return act(chain, r, r.status === "forwarding" ? "forward" : "refund", r.reason ?? (r.status === "forwarding" ? "agreed" : "refund"));
}

async function act(chain: EscrowChain, r: EscrowRow, action: "forward" | "refund", reason: string): Promise<string> {
  setRow(r.job_id, { status: action === "forward" ? "forwarding" : "refunding", reason, error: null });
  const onSent = (h: Hex) => setRow(r.job_id, { settle_tx: h });
  try {
    const h = action === "forward" ? await chain.forward(r.escrow_id, onSent) : await chain.refund(r.escrow_id, onSent);
    return finalize(r, action === "forward" ? "forwarded" : "refunded", h);
  } catch (e) {
    const st = await chain.escrowState(r.escrow_id).catch(() => null);
    if (st && (st.state === "forwarded" || st.state === "refunded")) return finalize(r, st.state, null); // settled by someone else
    setRow(r.job_id, { error: describeChainError(e) });
    return `${r.job_id.slice(0, 10)}: ${action} failed (${describeChainError(e)})`;
  }
}

function finalize(r: EscrowRow, state: "forwarded" | "refunded", h: Hex | null): string {
  const now = nowSec();
  getDb()
    .prepare("UPDATE x402_escrows SET status = ?, settle_tx = COALESCE(?, settle_tx), settled_at = ?, updated_at = ?, error = NULL WHERE job_id = ?")
    .run(state, h, now, now, r.job_id);
  return `${r.job_id.slice(0, 10)}: ${state}`;
}

function setRow(jobId: string, f: Partial<Pick<EscrowRow, "status" | "reason" | "deadline" | "error" | "settle_tx">>) {
  const keys = Object.keys(f) as (keyof typeof f)[];
  if (!keys.length) return;
  getDb()
    .prepare(`UPDATE x402_escrows SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE job_id = ?`)
    .run(...keys.map((k) => (f[k] ?? null) as string | number | null), nowSec(), jobId);
}

const g = globalThis as typeof globalThis & { __sparecycleX402Timer?: ReturnType<typeof setInterval> };

/**
 * Starts the settlement timer (called once from bootScheduler) when x402 is on or escrows are still open. Without
 * either, nothing starts. The first tick also runs the preflight, so a misconfiguration shows in the log at boot.
 */
export function startX402Timer() {
  if (g.__sparecycleX402Timer) return;
  const cfg = x402Config();
  let open = false;
  try {
    open = getDb().prepare("SELECT 1 FROM x402_escrows WHERE status IN ('funding','held','forwarding','refunding') LIMIT 1").get() !== undefined;
  } catch {
    return;
  }
  if (!cfg && !open) return;
  if (cfg) void x402Ready(cfg);
  g.__sparecycleX402Timer = setInterval(() => {
    settleX402()
      .then((s) => {
        if (s !== "nothing to settle" && s !== "x402 settlement already running") console.log(`[sparecycle] x402: ${s}`);
      })
      .catch((e) => console.error(`[sparecycle] x402 settle: ${e instanceof Error ? e.message : String(e)}`));
  }, X402_SETTLE_TICK_MS);
  g.__sparecycleX402Timer.unref?.();
  console.log(`[sparecycle] x402 ${cfg ? "on" : "off for new payments"} (INTERNAL REVIEW ONLY, not externally audited): escrow settlement every ${X402_SETTLE_TICK_MS / 1000} s`);
}

// ---- Epoch tree and receipts --------------------------------------------------------------------------------------------

const isHex32 = (v: string | null): v is Hex => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Builds epoch `epochId`'s x402 tree over every escrow that reached an outcome and is in no tree yet (call at the epoch
 * close). Idempotent per epoch. Returns a one-line summary, or null when there is nothing to seal; never throws.
 */
export function sealX402Epoch(epochId: number): string | null {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT e.job_id, e.escrow_id, e.payer, e.asset, e.amount, e.status, j.status AS job_status, j.output_hash
         FROM x402_escrows e LEFT JOIN jobs j ON j.id = e.job_id
         WHERE e.status IN ('forwarded','refunded') AND e.leaf_epoch IS NULL ORDER BY e.job_id`,
      )
      .all() as { job_id: Hex; escrow_id: Hex; payer: Address; asset: Address; amount: string; status: X402LeafOutcome; job_status: string | null; output_hash: string | null }[];
    if (!rows.length) return null;
    if (db.prepare("SELECT 1 FROM x402_roots WHERE epoch_id = ?").get(epochId)) return `x402 tree of epoch ${epochId} already built`;
    const entries: X402LeafEntry[] = rows.map((r) => {
      const verdict: X402LeafVerdict = r.job_status && r.job_status in X402_LEAF_VERDICT ? (r.job_status as X402LeafVerdict) : "not-queued";
      return {
        jobId: r.job_id,
        escrowId: r.escrow_id,
        payer: getAddress(r.payer),
        asset: getAddress(r.asset),
        amount: BigInt(r.amount),
        verdict,
        outcome: r.status,
        outputHash: verdict === "agreed" && isHex32(r.output_hash) ? (r.output_hash.toLowerCase() as Hex) : null,
        salt: newLeafSalt(),
      };
    });
    const leaves = entries.map((e) => ({ ...e, leaf: x402LeafOf(epochId, e) }));
    const tree = buildTree(leaves.map((l) => l.leaf));
    tx((d) => {
      const ins = d.prepare(
        "INSERT INTO x402_leaves (epoch_id, job_id, escrow_id, payer, asset, amount, verdict, outcome, output_hash, salt, leaf) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const mark = d.prepare("UPDATE x402_escrows SET leaf_epoch = ? WHERE job_id = ?");
      for (const l of leaves) {
        ins.run(epochId, l.jobId, l.escrowId, l.payer, l.asset, l.amount.toString(), l.verdict, l.outcome, l.outputHash, l.salt, l.leaf);
        mark.run(epochId, l.jobId);
      }
      d.prepare("INSERT INTO x402_roots (epoch_id, root, leaves, created_at) VALUES (?, ?, ?, ?)").run(epochId, tree.root, leaves.length, nowSec());
    });
    return `x402 tree of epoch ${epochId}: ${leaves.length} escrow(s), root ${tree.root}`;
  } catch (e) {
    return `x402 tree of epoch ${epochId} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The `x402` block of GET /api/v1/epochs/:id/charges: {} unless that epoch has an x402 tree. No job ids, payers or salts. */
export function x402ChargesOf(epochId: number) {
  const root = getDb().prepare("SELECT root, leaves FROM x402_roots WHERE epoch_id = ?").get(epochId) as { root: Hex; leaves: number } | undefined;
  if (!root) return {};
  const leaves = (getDb().prepare("SELECT leaf FROM x402_leaves WHERE epoch_id = ?").all(epochId) as { leaf: Hex }[]).map((l) => l.leaf);
  return {
    x402: {
      hashRule: X402_HASH_RULE,
      root: root.root,
      leaves: buildTree(leaves).layers[0],
      leafRule: X402_LEAF_RULE,
      codes: { verdict: X402_LEAF_VERDICT, outcome: X402_LEAF_OUTCOME },
      anchor:
        "No on-chain root: each leaf's escrow outcome is on-chain as the escrow contract's Funded and Forwarded / Refunded events under escrowId = keccak256(abi.encode(jobId, escrowSalt)); the payer's receipt carries both salts.",
    },
  };
}

/** The receipt of an x402 job (GET /api/v1/jobs/:id/receipt, after its access check). */
export function x402Receipt(jobId: string) {
  const r = getDb().prepare("SELECT * FROM x402_escrows WHERE job_id = ?").get(jobId) as EscrowRow | undefined;
  if (!r) return null;
  const leaf = getDb().prepare("SELECT * FROM x402_leaves WHERE job_id = ?").get(jobId) as
    | { epoch_id: number; verdict: X402LeafVerdict; outcome: X402LeafOutcome; output_hash: string | null; salt: Hex; leaf: Hex }
    | undefined;
  let anchor = null;
  if (leaf) {
    const all = (getDb().prepare("SELECT leaf FROM x402_leaves WHERE epoch_id = ?").all(leaf.epoch_id) as { leaf: Hex }[]).map((l) => l.leaf);
    const tree = buildTree(all);
    anchor = {
      hashRule: X402_HASH_RULE,
      epochId: leaf.epoch_id,
      leafInputs: {
        epochId: leaf.epoch_id,
        jobId: r.job_id,
        escrowId: r.escrow_id,
        payer: r.payer,
        asset: r.asset,
        amount: r.amount,
        verdict: X402_LEAF_VERDICT[leaf.verdict],
        outcome: X402_LEAF_OUTCOME[leaf.outcome],
        outputHash: leaf.output_hash ?? `0x${"00".repeat(32)}`,
        salt: leaf.salt,
      },
      leaf: leaf.leaf,
      proof: getProof(tree, leaf.leaf),
      root: tree.root,
    };
  }
  return {
    format: "sparecycle-x402-receipt" as const,
    version: 1 as const,
    review: "internal review only, not externally audited",
    state: anchor ? ("sealed" as const) : ("provisional" as const),
    chainId: targetChain.id,
    network: r.network,
    escrow: r.escrow,
    asset: r.asset,
    jobId: r.job_id,
    payer: r.payer,
    amount: r.amount,
    /** Private: with it, escrowId = keccak256(abi.encode(jobId, escrowSalt)) ties the escrow events to this job. */
    escrowSalt: r.escrow_salt,
    escrowId: r.escrow_id,
    escrowStatus: r.status,
    reason: r.reason,
    deadline: r.deadline,
    fundTx: r.fund_tx,
    settleTx: r.settle_tx,
    anchor,
  };
}
