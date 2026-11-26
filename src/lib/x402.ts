// x402 pay-per-job: the wire format (x402 v2, https://github.com/x402-foundation/x402 specs/x402-specification-v2.md
// and specs/transports-v2/http.md), the `exact` EVM scheme's EIP-3009 typed data (specs/schemes/exact/
// scheme_exact_evm.md), the escrow id and the x402 jobs-tree leaf. INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.
// Pure (viem only): the scheduler (src/server/x402.ts), the unit tests and scripts/e2e-local.mjs share it.
//
//   402      header PAYMENT-REQUIRED  = base64(JSON PaymentRequired)
//   retry    header PAYMENT-SIGNATURE = base64(JSON PaymentPayload)
//   success  header PAYMENT-RESPONSE  = base64(JSON SettleResponse)
//
// Sparecycle settles into an escrow (contracts/src/SparecycleX402Escrow.sol): `payTo` is the escrow contract, the
// payment is moved there before the job is queued, and it is forwarded (two nodes agreed) or refunded (they did not)
// later. The escrow keys each payment by escrowId = keccak256(abi.encode(jobId, salt)); the salt stays private.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const X402_VERSION = 2 as const;

/** HTTP header names of x402 v2 (lowercase, as Headers stores them). */
export const X402_HEADERS = {
  required: "payment-required",
  signature: "payment-signature",
  response: "payment-response",
} as const;

/** CAIP-2 id of an EVM chain, e.g. eip155:4663 for Robinhood Chain. */
export const caip2 = (chainId: number) => `eip155:${chainId}`;

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  /** Atomic units of `asset`, decimal string. */
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  /** EIP-712 domain of the asset (`name`, `version`) and the transfer method. */
  extra: { name: string; version: string; assetTransferMethod: "eip3009" };
};

export type ResourceInfo = { url: string; description?: string; mimeType?: string; serviceName?: string };

export type PaymentRequired = {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, { info: unknown; schema: unknown }>;
};

export type Eip3009Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: Hex; authorization: Eip3009Authorization };
  extensions?: Record<string, unknown>;
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: Address;
  /** The escrow funding transaction ("" when nothing was sent). */
  transaction: Hex | "";
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
};

/** EIP-3009 TransferWithAuthorization typed data (identical in the x402 SDK, USDC and USDG). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The EIP-712 domain a payer signs for: the asset's name and version, this chain, the asset contract. */
export const assetDomain = (r: Pick<PaymentRequirements, "asset" | "extra">, chainId: number) => ({
  name: r.extra.name,
  version: r.extra.version,
  chainId,
  verifyingContract: r.asset,
});

/** The typed-data message of an authorization (uint256 fields as bigints). */
export const authorizationMessage = (a: Eip3009Authorization) => ({
  from: a.from,
  to: a.to,
  value: BigInt(a.value),
  validAfter: BigInt(a.validAfter),
  validBefore: BigInt(a.validBefore),
  nonce: a.nonce,
});

const toB64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** base64(UTF-8 JSON), the encoding of all three x402 headers. */
export const encodeX402Header = (value: unknown): string => toB64(new TextEncoder().encode(JSON.stringify(value)));

/** Inverse of encodeX402Header; throws on anything that is not base64 JSON. */
export function decodeX402Header<T = unknown>(header: string): T {
  if (header.length > 16_384 || !/^[A-Za-z0-9+/=\s]+$/.test(header)) throw new Error("not base64");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64(header.trim()))) as T;
}

/** The on-chain key of a job's escrow. The salt is private: without it the public events cannot be tied to the job. */
export const escrowIdOf = (jobId: Hex, salt: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [jobId, salt]));

// ---- The x402 jobs tree (one per epoch close, like the charge's jobs tree in ./job-receipt.ts) --------------------

export const X402_HASH_RULE = "x402-escrow-merkle-v1" as const;
/** Verdict codes of an x402 leaf: the job verdicts, plus 5 for a paid job that could not be queued (refunded). */
export const X402_LEAF_VERDICT = { agreed: 1, disagreed: 2, expired: 3, rejected: 4, "not-queued": 5 } as const;
/** Outcome codes: what the escrow did on-chain. */
export const X402_LEAF_OUTCOME = { forwarded: 1, refunded: 2 } as const;
export type X402LeafVerdict = keyof typeof X402_LEAF_VERDICT;
export type X402LeafOutcome = keyof typeof X402_LEAF_OUTCOME;

export const X402_LEAF_RULE =
  "keccak256(abi.encode(uint64 epochId, bytes32 jobId, bytes32 escrowId, address payer, address asset, uint256 amount, uint8 verdict, uint8 outcome, bytes32 outputHash, bytes32 salt)); salt = 32 random bytes per leaf, only in the payer's receipt; sorted-pair keccak256 tree (src/lib/merkle.ts)";

export type X402LeafEntry = {
  jobId: Hex;
  escrowId: Hex;
  payer: Address;
  asset: Address;
  amount: bigint;
  verdict: X402LeafVerdict;
  outcome: X402LeafOutcome;
  outputHash: Hex | null;
  salt: Hex;
};

const ZERO32: Hex = `0x${"00".repeat(32)}`;

export function x402LeafOf(epochId: bigint | number, e: X402LeafEntry): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        BigInt(epochId),
        e.jobId,
        e.escrowId,
        e.payer,
        e.asset,
        e.amount,
        X402_LEAF_VERDICT[e.verdict],
        X402_LEAF_OUTCOME[e.outcome],
        e.outputHash ?? ZERO32,
        e.salt,
      ],
    ),
  );
}
