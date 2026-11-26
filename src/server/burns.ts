// Usage burn, phase 2a (brief §4, docs/token-features.md), behind TOKEN_BURNS (default off). NOTHING HERE SIGNS OR
// SENDS: the scheduler prepares an UNSIGNED Safe transaction for the treasury Safe's signers, who decide to execute it.
//
// Per closed epoch with a confirmed charge:
//   share    = Charged.toTreasury x SPLIT_BURN_BPS / 500           (N1: 150 of the 500 bps; read from the charge's log)
//   due      = share + carry-in                                    (what earlier plans did not buy)
//   cap      = 1% of the pool's quote-side (ETH) liquidity          (N12; virtual in-range reserve L / sqrtP at the read)
//   buy      = min(due, cap); carry-out = due - buy                  (never buy at any price on a thin pool)
//   minOut   = the constant-product quote of `buy` at the read, minus 2% (N12)
//   payload  = one SafeTx: Universal Router execute(V4_SWAP ETH -> SPARE, amountOutMinimum = minOut) with the bought SPARE
//              taken straight to the dead address (BURN_METHOD "dead"), or paid to the Safe and then SPARE.burn()
//              (BURN_METHOD "burn", batched through MultiSendCallOnly). Router deadline: BURN_PAYLOAD_TTL_SECONDS.
// A plan that cannot be completed (a contract or address not recorded in src/lib/addresses.ts, no pool read) is stored
// `incomplete` with what is missing, buys nothing and carries the whole due amount over (`carried` when the cap itself
// allowed no buy). A prepared plan that is not
// executed before its deadline becomes `expired` at the next close and its buy is carried over too; one executed by
// the treasury Safe (matched by SafeTx hash, or by the hash of its data) becomes `executed`.
//
// The public burn rows (holder page) come ONLY from on-chain events: SPARE Transfer logs to the zero or dead address in
// transactions executed by the treasury Safe (2a), Burned events of SparecycleBurner (2b, not deployed), and SPARE
// leaving SparecycleNodeStake to a burn sink (executed slashes, shown apart). A plan never makes a burn row; it only
// names the epoch of an executed one and gives the "carried over" rows their amount and reason.
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  hashTypedData,
  keccak256,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { targetChain } from "@/lib/chain";
import { ADDR, BURN_SINKS, SAFE_MULTISEND_CALL_ONLY, SPARE_START_BLOCK, TOKEN_CONTRACTS, UNISWAP_V4 } from "@/lib/addresses";
import { safeAbi, spareTokenAbi, UR_COMMAND_V4_SWAP, universalRouterAbi, V4_ACTION } from "@/lib/token-contracts";
import { BURN_CAP_BPS_OF_QUOTE_LIQUIDITY, BURN_MAX_SLIPPAGE_BPS, BURN_METHOD, BURN_PAYLOAD_TTL_SECONDS, burnShareOf } from "@/lib/token-rules";
import { NotLiveError, tokenChain, type PoolRead, type SpareTransfer } from "./chain-io";
import { getDb, nowSec, tx } from "./db";

const Q96 = 1n << 96n;
const ZERO_ADDRESS = BURN_SINKS.zero;

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** The v4 pool id: keccak256(abi.encode(PoolKey)). */
export const poolIdOf = (k: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );

// ---- Pure math --------------------------------------------------------------------------------------------------

/** In-range virtual reserves of the ETH/SPARE pool (currency0 = native ETH): x = L / sqrtP, y = L x sqrtP. */
export function reservesOf(pool: Pick<PoolRead, "sqrtPriceX96" | "liquidity">): { eth: bigint; spare: bigint } {
  if (pool.sqrtPriceX96 <= 0n) return { eth: 0n, spare: 0n };
  return { eth: (pool.liquidity * Q96) / pool.sqrtPriceX96, spare: (pool.liquidity * pool.sqrtPriceX96) / Q96 };
}

/** N12 cap: BURN_CAP_BPS_OF_QUOTE_LIQUIDITY of the quote-side (ETH) reserve at the read. */
export const burnCapOf = (pool: Pick<PoolRead, "sqrtPriceX96" | "liquidity">): bigint =>
  (reservesOf(pool).eth * BigInt(BURN_CAP_BPS_OF_QUOTE_LIQUIDITY)) / 10_000n;

/** SPARE out for `amountIn` ETH, constant product on the in-range reserves after the LP fee (hundredths of a bip). */
export function quoteSpareOut(pool: Pick<PoolRead, "sqrtPriceX96" | "liquidity" | "lpFee">, amountIn: bigint): bigint {
  const { eth, spare } = reservesOf(pool);
  const inAfterFee = (amountIn * BigInt(1_000_000 - pool.lpFee)) / 1_000_000n;
  if (eth + inAfterFee === 0n) return 0n;
  return (spare * inAfterFee) / (eth + inAfterFee);
}

/** minOut = quote x (1 - BURN_MAX_SLIPPAGE_BPS). */
export const minOutOf = (quote: bigint): bigint => (quote * BigInt(10_000 - BURN_MAX_SLIPPAGE_BPS)) / 10_000n;

export type BurnPlanMath = { share: bigint; due: bigint; cap: bigint | null; buy: bigint; carryOut: bigint; minOut: bigint | null };

/** The amounts of one epoch's plan. `pool` null = no price read: nothing is bought and the whole due amount carries over. */
export function planEpochBurn(input: { toTreasury: bigint; carryIn: bigint; pool: PoolRead | null }): BurnPlanMath {
  const share = burnShareOf(input.toTreasury);
  const due = share + input.carryIn;
  if (!input.pool) return { share, due, cap: null, buy: 0n, carryOut: due, minOut: null };
  const cap = burnCapOf(input.pool);
  const buy = due < cap ? due : cap;
  return { share, due, cap, buy, carryOut: due - buy, minOut: buy > 0n ? minOutOf(quoteSpareOut(input.pool, buy)) : null };
}

// ---- Payload encoding (unsigned) ---------------------------------------------------------------------------------

const exactInputSingle = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/**
 * Universal Router execute(...) calldata: one V4_SWAP of exactly `amountIn` ETH for SPARE with `minOut`, settled from the
 * router's ETH (the call's value), the SPARE taken to `takeTo` ("dead" = the dead address, "sender" = the caller: the Safe).
 */
export function encodeBurnSwap(p: { poolKey: PoolKey; amountIn: bigint; minOut: bigint; takeTo: "dead" | "sender"; deadline: bigint }): Hex {
  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, p.takeTo === "dead" ? V4_ACTION.TAKE : V4_ACTION.TAKE_ALL],
  );
  const swap = encodeAbiParameters(exactInputSingle, [
    { poolKey: p.poolKey, zeroForOne: true, amountIn: p.amountIn, amountOutMinimum: p.minOut, hookData: "0x" },
  ]);
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [p.poolKey.currency0, p.amountIn]);
  const take =
    p.takeTo === "dead"
      ? // TAKE(currency, recipient, amount 0 = the whole open delta)
        encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [p.poolKey.currency1, BURN_SINKS.dead, 0n])
      : // TAKE_ALL(currency, minAmount)
        encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [p.poolKey.currency1, p.minOut]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [numberToHex(UR_COMMAND_V4_SWAP, { size: 1 }), [input], p.deadline],
  });
}

/** MultiSendCallOnly.multiSend(bytes) of plain calls (operation 0). */
export function encodeMultiSend(calls: { to: Address; value: bigint; data: Hex }[]): Hex {
  const packed = concat(
    calls.map((c) =>
      encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value, BigInt((c.data.length - 2) / 2), c.data]),
    ),
  );
  return encodeFunctionData({
    abi: [{ type: "function", name: "multiSend", stateMutability: "payable", inputs: [{ name: "transactions", type: "bytes" }], outputs: [] }],
    functionName: "multiSend",
    args: [packed],
  });
}

export type SafeTx = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
};

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The EIP-712 SafeTx hash (Safe 1.3+ domain: chainId and verifyingContract): what the Safe's signers sign. */
export const safeTxHashOf = (chainId: number, safe: Address, t: SafeTx): Hex =>
  hashTypedData({ domain: { chainId, verifyingContract: safe }, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: t });

const plainSafeTx = (to: Address, value: bigint, data: Hex, operation: 0 | 1, nonce: bigint): SafeTx => ({
  to,
  value,
  data,
  operation,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO_ADDRESS,
  refundReceiver: ZERO_ADDRESS,
  nonce,
});

/** JSON-safe SafeTx (bigints as decimal strings). */
export const safeTxJson = (t: SafeTx) => ({ ...t, value: t.value.toString(), safeTxGas: "0", baseGas: "0", gasPrice: "0", nonce: t.nonce.toString() });

/** A Safe Transaction Builder batch file (import it in the Safe app) for the same calls. */
export const txBuilderBatch = (chainId: number, safe: Address, name: string, description: string, calls: { to: Address; value: bigint; data: Hex }[]) => ({
  version: "1.0",
  chainId: String(chainId),
  createdAt: Date.now(),
  meta: { name, description, createdFromSafeAddress: safe },
  transactions: calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data, contractMethod: null, contractInputsValues: null })),
});

// ---- The plan runner ----------------------------------------------------------------------------------------------

/** What a complete payload needs, from src/lib/addresses.ts. Tests pass their own; production uses defaultBurnInfra(). */
export type BurnInfra = {
  chainId: number;
  safe: Address;
  spareToken: Address;
  router: Address | null;
  poolKey: PoolKey | null;
  poolId: Hex;
  multiSend: Address | null;
  method: "dead" | "burn";
};

export const defaultBurnInfra = (): BurnInfra => ({
  chainId: targetChain.id,
  safe: ADDR.treasurySafe,
  spareToken: ADDR.spareToken,
  router: UNISWAP_V4.universalRouter,
  poolKey: UNISWAP_V4.spareEthPoolKey,
  poolId: UNISWAP_V4.spareEthPoolId,
  multiSend: SAFE_MULTISEND_CALL_ONLY,
  method: BURN_METHOD,
});

type PlanRow = {
  epoch_id: number;
  charge_tx: string | null;
  to_treasury_wei: string;
  share_wei: string;
  carry_in_wei: string;
  due_wei: string;
  cap_wei: string | null;
  buy_wei: string;
  carry_out_wei: string;
  min_out_wei: string | null;
  pool_read: string | null;
  method: string;
  status: "prepared" | "incomplete" | "nothing-due" | "carried" | "executed" | "expired";
  missing: string | null;
  safe_tx: string | null;
  safe_tx_hash: Hex | null;
  data_hash: Hex | null;
  deadline: number | null;
  prepared_block: number | null;
  executed_tx: string | null;
  created_at: number;
};

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

/** Marks prepared plans executed (found on-chain) or expired (deadline passed, not found). Returns the ETH to carry over. */
async function settlePreparedPlans(): Promise<bigint> {
  const db = getDb();
  const open = db.prepare("SELECT * FROM token_burn_plans WHERE status = 'prepared' ORDER BY epoch_id").all() as PlanRow[];
  if (!open.length) return 0n;
  const from = BigInt(Math.min(...open.map((p) => p.prepared_block ?? 0)));
  const execs = await tokenChain.safeExecutions(from);
  const byHash = new Map(execs.map((e) => [e.safeTxHash.toLowerCase(), e]));
  const unmatched = open.filter((p) => !(p.safe_tx_hash && byHash.has(p.safe_tx_hash.toLowerCase())));
  const dataHashToTx = new Map<string, Hex>();
  if (unmatched.length) {
    // Executed at another nonce (another Safe transaction went first): same calls, so the same data.
    for (const e of execs) {
      const ctx = await tokenChain.burnTxContext(e.txHash);
      try {
        const { args } = decodeFunctionData({ abi: safeAbi, data: ctx.input });
        dataHashToTx.set(keccak256(args[2] as Hex).toLowerCase(), e.txHash);
      } catch {
        /* not an execTransaction call (e.g. through a module or a relayer contract): no data match */
      }
    }
  }
  let carry = 0n;
  const now = nowSec();
  tx(() => {
    for (const p of open) {
      const hit = (p.safe_tx_hash && byHash.get(p.safe_tx_hash.toLowerCase())?.txHash) || (p.data_hash && dataHashToTx.get(p.data_hash.toLowerCase()));
      if (hit) {
        db.prepare("UPDATE token_burn_plans SET status = 'executed', executed_tx = ? WHERE epoch_id = ?").run(hit, p.epoch_id);
      } else if (p.deadline !== null && p.deadline < now) {
        db.prepare("UPDATE token_burn_plans SET status = 'expired' WHERE epoch_id = ?").run(p.epoch_id);
        carry += BigInt(p.buy_wei);
      }
    }
  });
  return carry;
}

/** Builds the unsigned payload of a plan, or the list of what is missing for it. */
async function buildPayload(buy: bigint, minOut: bigint, infra: BurnInfra): Promise<{ missing: string[]; payload?: { safeTx: SafeTx; calls: { to: Address; value: bigint; data: Hex }[] } }> {
  const missing: string[] = [];
  if (!infra.router) missing.push("Uniswap v4 Universal Router address (src/lib/addresses.ts UNISWAP_V4.universalRouter)");
  if (!infra.poolKey) missing.push("SPARE/ETH pool key (UNISWAP_V4.spareEthPoolKey)");
  else {
    if (poolIdOf(infra.poolKey).toLowerCase() !== infra.poolId.toLowerCase()) missing.push("the pool key does not hash to the recorded SPARE/ETH pool id");
    if (infra.poolKey.currency0 !== ZERO_ADDRESS || infra.poolKey.currency1.toLowerCase() !== infra.spareToken.toLowerCase()) {
      missing.push("the pool key is not native ETH / SPARE");
    }
  }
  if (infra.method === "burn" && !infra.multiSend) missing.push("Safe MultiSendCallOnly address (SAFE_MULTISEND_CALL_ONLY), needed to batch the swap and burn()");
  if (missing.length) return { missing };
  let nonce: bigint;
  let safeSpare = 0n;
  try {
    nonce = await tokenChain.safeNonce();
    if (infra.method === "burn") safeSpare = await tokenChain.spareBalanceOf(infra.safe);
  } catch (e) {
    return { missing: [`treasury Safe read failed: ${errText(e)}`] };
  }
  const deadline = BigInt(nowSec() + BURN_PAYLOAD_TTL_SECONDS);
  const router = infra.router!;
  const poolKey = infra.poolKey!;
  if (infra.method === "dead") {
    const data = encodeBurnSwap({ poolKey, amountIn: buy, minOut, takeTo: "dead", deadline });
    const call = { to: router, value: buy, data };
    return { missing, payload: { safeTx: plainSafeTx(router, buy, data, 0, nonce), calls: [call] } };
  }
  // "burn": SPARE comes to the Safe, then everything the Safe holds in SPARE up to minOut + what it held before is burned
  // (the Safe holds SPARE only as burn inventory, so a surplus above minOut is burned with the next epoch's batch).
  const calls = [
    { to: router, value: buy, data: encodeBurnSwap({ poolKey, amountIn: buy, minOut, takeTo: "sender", deadline }) },
    { to: infra.spareToken, value: 0n, data: encodeFunctionData({ abi: spareTokenAbi, functionName: "burn", args: [minOut + safeSpare] }) },
  ];
  return { missing, payload: { safeTx: plainSafeTx(infra.multiSend!, 0n, encodeMultiSend(calls), 1, nonce), calls } };
}

/**
 * Plans every confirmed charge that has no burn plan yet, oldest first (so the carry-over chains in order). Stops at the
 * first epoch whose charge cannot be read (it is retried at the next close). Returns one summary line.
 */
export async function prepareBurns(infra: BurnInfra = defaultBurnInfra()): Promise<string> {
  const db = getDb();
  const todo = db
    .prepare(
      `SELECT c.epoch_id AS epoch_id, c.tx AS tx FROM charges c WHERE c.status = 'done' AND c.tx IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM token_burn_plans p WHERE p.epoch_id = c.epoch_id) ORDER BY c.epoch_id`,
    )
    .all() as { epoch_id: number; tx: Hex }[];
  if (!todo.length) return "burns: no new charge to plan";
  const lines: string[] = [];
  for (const c of todo) {
    let charged;
    try {
      charged = await tokenChain.chargedEvent(c.tx);
    } catch (e) {
      lines.push(`epoch ${c.epoch_id}: charge not readable (${errText(e)}); retried at the next close`);
      break;
    }
    if (!charged) {
      lines.push(`epoch ${c.epoch_id}: no Charged log in ${c.tx}; not planned`);
      break;
    }
    let expiredCarry = 0n;
    try {
      expiredCarry = await settlePreparedPlans();
    } catch (e) {
      lines.push(`epoch ${c.epoch_id}: could not check earlier plans on-chain (${errText(e)}); retried at the next close`);
      break;
    }
    const prev = db.prepare("SELECT carry_out_wei FROM token_burn_plans WHERE epoch_id < ? ORDER BY epoch_id DESC LIMIT 1").get(c.epoch_id) as
      | { carry_out_wei: string }
      | undefined;
    const carryIn = BigInt(prev?.carry_out_wei ?? "0") + expiredCarry;
    let pool: PoolRead | null = null;
    const missing: string[] = [];
    try {
      pool = await tokenChain.poolState();
    } catch (e) {
      missing.push(e instanceof NotLiveError ? "Uniswap v4 StateView address (UNISWAP_V4.stateView): no price read" : `pool read failed: ${errText(e)}`);
    }
    let math = planEpochBurn({ toTreasury: charged.toTreasury, carryIn, pool });
    let built: Awaited<ReturnType<typeof buildPayload>> | null = null;
    if (pool && math.buy > 0n && math.minOut !== null) {
      built = await buildPayload(math.buy, math.minOut, infra);
      missing.push(...built.missing);
    }
    if (missing.length) math = { ...math, buy: 0n, carryOut: math.due };
    // carried = the cap allowed no buy at all (an empty pool side): everything due waits for the next epoch.
    const status: PlanRow["status"] = missing.length ? "incomplete" : math.due === 0n ? "nothing-due" : math.buy === 0n ? "carried" : "prepared";
    const payload = status === "prepared" ? built!.payload! : null;
    const head = await tokenChain.headBlock().catch(() => null);
    const safeTxHash = payload ? safeTxHashOf(infra.chainId, infra.safe, payload.safeTx) : null;
    db.prepare(
      `INSERT INTO token_burn_plans (epoch_id, charge_tx, to_treasury_wei, share_wei, carry_in_wei, due_wei, cap_wei, buy_wei, carry_out_wei,
         min_out_wei, pool_read, method, status, missing, safe_tx, safe_tx_hash, data_hash, deadline, prepared_block, executed_tx, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      c.epoch_id,
      c.tx,
      charged.toTreasury.toString(),
      math.share.toString(),
      carryIn.toString(),
      math.due.toString(),
      math.cap?.toString() ?? null,
      math.buy.toString(),
      math.carryOut.toString(),
      payload ? math.minOut!.toString() : null,
      pool ? JSON.stringify({ sqrtPriceX96: pool.sqrtPriceX96.toString(), liquidity: pool.liquidity.toString(), lpFee: pool.lpFee, block: pool.block.toString() }) : null,
      infra.method,
      status,
      missing.length ? JSON.stringify(missing) : null,
      payload
        ? JSON.stringify({
            unsigned: true,
            note: "Prepared by the scheduler for the treasury Safe's signers. Not signed, not sent.",
            safe: infra.safe,
            chainId: infra.chainId,
            safeTx: safeTxJson(payload.safeTx),
            safeTxHash,
            builder: txBuilderBatch(
              infra.chainId,
              infra.safe,
              `Sparecycle burn, epoch ${c.epoch_id}`,
              `Buy SPARE with ${math.buy} wei (minOut ${math.minOut}) and burn it (${infra.method}).`,
              payload.calls,
            ),
          })
        : null,
      safeTxHash,
      payload ? keccak256(payload.safeTx.data) : null,
      payload ? Number(decodeDeadline(payload.calls[0].data)) : null,
      head === null ? null : Number(head),
      nowSec(),
    );
    lines.push(
      `epoch ${c.epoch_id}: ${status}, share ${math.share} wei + carry ${carryIn} wei, buy ${math.buy} wei, carry over ${math.carryOut} wei` +
        (missing.length ? ` (missing: ${missing.join("; ")})` : "") +
        (safeTxHash ? `, SafeTx ${safeTxHash} (NOT signed, NOT sent)` : ""),
    );
  }
  return `burns: ${lines.join(" | ")}`;
}

/** The deadline argument of a Universal Router execute(...) call. */
function decodeDeadline(data: Hex): bigint {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data });
  return args[2];
}

// ---- Public read model (on-chain rows only) -----------------------------------------------------------------------

export type BurnRow = {
  /** 2a = executed by the treasury Safe; 2b = a Burned event of SparecycleBurner. */
  path: "2a" | "2b";
  txHash: Hex;
  block: bigint;
  time: number;
  spareBurned: bigint;
  /** ETH spent on the buy in the same transaction (the pool's Swap event), null = no swap found in it. */
  ethIn: bigint | null;
  /** The epoch of the plan the transaction executed (2a), or Burned.epochId (2b); null = not matched to a plan. */
  epochId: number | null;
};
export type SlashBurnRow = { txHash: Hex; block: bigint; spareBurned: bigint };
export type CarryRow = { epochId: number; chargeTx: string | null; carriedWei: bigint; reason: string };

/** Sums the SPARE sent to a burn sink per transaction. */
function byTx(transfers: SpareTransfer[]): Map<Hex, { block: bigint; value: bigint; from: Address[] }> {
  const m = new Map<Hex, { block: bigint; value: bigint; from: Address[] }>();
  for (const t of transfers) {
    const e = m.get(t.txHash) ?? { block: t.block, value: 0n, from: [] };
    e.value += t.value;
    e.from.push(t.from);
    m.set(t.txHash, e);
  }
  return m;
}

/**
 * On-chain burn rows since `fromBlock`: SPARE to zero/dead in transactions executed by the treasury Safe (2a), Burned
 * events (2b, when SparecycleBurner is live) and SPARE leaving SparecycleNodeStake to a sink (slashes, when live).
 */
export async function readBurnRows(fromBlock: bigint) {
  const transfers = await tokenChain.spareBurnTransfers(fromBlock);
  const plans = getDb().prepare("SELECT epoch_id, safe_tx_hash, data_hash, executed_tx FROM token_burn_plans").all() as Pick<
    PlanRow,
    "epoch_id" | "safe_tx_hash" | "data_hash" | "executed_tx"
  >[];
  const rows: BurnRow[] = [];
  const slashes: SlashBurnRow[] = [];
  const stake = TOKEN_CONTRACTS.nodeStake?.toLowerCase() ?? null;
  for (const [txHash, t] of byTx(transfers)) {
    if (stake && t.from.every((f) => f.toLowerCase() === stake)) {
      slashes.push({ txHash, block: t.block, spareBurned: t.value });
      continue;
    }
    const ctx = await tokenChain.burnTxContext(txHash);
    if (!ctx.to || ctx.to.toLowerCase() !== ADDR.treasurySafe.toLowerCase() || !ctx.safeExecution) continue; // not the Safe's
    let dataHash: string | null = null;
    try {
      dataHash = keccak256(decodeFunctionData({ abi: safeAbi, data: ctx.input }).args[2] as Hex).toLowerCase();
    } catch {
      /* not an execTransaction input */
    }
    const plan = plans.find(
      (p) =>
        p.executed_tx?.toLowerCase() === txHash.toLowerCase() ||
        p.safe_tx_hash?.toLowerCase() === ctx.safeExecution!.toLowerCase() ||
        (dataHash !== null && p.data_hash?.toLowerCase() === dataHash),
    );
    rows.push({ path: "2a", txHash, block: t.block, time: ctx.time, spareBurned: t.value, ethIn: ctx.ethIn, epochId: plan?.epoch_id ?? null });
  }
  let burner: "not-live" | "live" = "not-live";
  if (TOKEN_CONTRACTS.burner) {
    burner = "live";
    for (const b of await tokenChain.burnedEvents(fromBlock)) {
      rows.push({ path: "2b", txHash: b.txHash, block: b.block, time: await tokenChain.blockTime(b.block), spareBurned: b.spareBurned, ethIn: b.ethIn, epochId: Number(b.epochId) });
    }
  }
  rows.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
  return { rows, slashes, burner, stakeLive: stake !== null };
}

/** "Carried over" rows: every planned epoch that left part of its due amount unbought, with the amount and the reason. */
export function carryRows(): CarryRow[] {
  const plans = getDb().prepare("SELECT * FROM token_burn_plans ORDER BY epoch_id").all() as PlanRow[];
  return plans
    .filter((p) => BigInt(p.carry_out_wei) > 0n || p.status === "expired")
    .map((p) => ({
      epochId: p.epoch_id,
      chargeTx: p.charge_tx,
      carriedWei: p.status === "expired" ? BigInt(p.carry_out_wei) + BigInt(p.buy_wei) : BigInt(p.carry_out_wei),
      reason:
        p.status === "expired"
          ? "carried over (not executed before its deadline)"
          : p.status === "incomplete"
            ? "carried over (burn path not live)"
            : "carried over (cap)",
    }));
}

/** The block the public burn rows are read from (null = SPARE_START_BLOCK not recorded: not live). */
export const burnScanStart = (): bigint | null => SPARE_START_BLOCK;

/** Operator view of the stored plans (never public: a prepared buy is a trade signal on a thin pool). */
export function burnPlansJson() {
  const rows = getDb().prepare("SELECT * FROM token_burn_plans ORDER BY epoch_id DESC LIMIT 100").all() as PlanRow[];
  return rows.map((p) => ({ ...p, missing: p.missing ? (JSON.parse(p.missing) as string[]) : null, safe_tx: p.safe_tx ? (JSON.parse(p.safe_tx) as unknown) : null }));
}

/** The charged epoch's Charged.toTreasury (null = no confirmed charge). Shared with ./holders. */
export async function epochTreasuryAmount(epochId: number): Promise<{ toTreasury: bigint; chargeTx: Hex } | null> {
  const c = getDb().prepare("SELECT tx FROM charges WHERE epoch_id = ? AND status = 'done' AND tx IS NOT NULL").get(epochId) as { tx: Hex } | undefined;
  if (!c) return null;
  const ev = await tokenChain.chargedEvent(c.tx);
  return ev ? { toTreasury: ev.toTreasury, chargeTx: c.tx } : null;
}

