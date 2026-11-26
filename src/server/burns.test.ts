// Usage burn, phase 2a (brief §4; src/server/burns.ts): the burn share (N1) of each confirmed charge, the cap and the
// slippage (N12) from a pool read, the carry-over (cap, not live, expired), the unsigned Safe transaction (Universal
// Router V4_SWAP decoded field by field, the SafeTx hash against Safe's own formula), executed plans found on-chain,
// and the public rows: only on-chain burn transfers in treasury Safe transactions, each with its transaction hash, the
// total equal to their sum. Every chain read is stubbed; nothing can be sent (no wallet code in the token modules).
// Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, getAddress, keccak256, pad, parseEther, toBytes, type Hex } from "viem";
import { setupTokenHarness } from "./test-support/token-harness";

let clockMs = Math.floor(Date.now() / 1000) * 1000;
const h = await setupTokenHarness();
mock.method(Date, "now", () => clockMs);
const { m } = h;
const B = await import("./burns");
const { tokenChain } = m.chainIo;
const { ADDR, BURN_SINKS, UNISWAP_V4 } = await import("@/lib/addresses");
const { universalRouterAbi, V4_ACTION, spareTokenAbi } = await import("@/lib/token-contracts");
const { BURN_PAYLOAD_TTL_SECONDS, BURN_MAX_SLIPPAGE_BPS, burnShareOf } = await import("@/lib/token-rules");
const db = () => m.db.getDb();
after(h.cleanup);

const Q96 = 1n << 96n;
/** SPARE per ETH = 4,000,000 (sqrtP = 2000), and 4.59 ETH of in-range quote-side liquidity, like the thin pool of §0.5. */
const POOL = { sqrtPriceX96: 2000n * Q96, liquidity: 9_180n * 10n ** 18n, lpFee: 3000, block: 123n };

describe("the math", () => {
  test("reserves, cap (1% of the ETH side), quote (net of the hook's 2.90% output cut) and minOut (2% under the quote)", () => {
    const r = B.reservesOf(POOL);
    assert.equal(r.eth, parseEther("4.59"));
    assert.equal(r.spare, 18_360_000n * 10n ** 18n);
    assert.equal(B.burnCapOf(POOL), parseEther("0.0459"));
    const amountIn = parseEther("0.0459");
    const inAfterFee = (amountIn * 997_000n) / 1_000_000n;
    const gross = (r.spare * inAfterFee) / (r.eth + inAfterFee);
    assert.equal(UNISWAP_V4.spareEthPoolHookCutBps, 290, "Pons hook: 100 bps fee + 190 bps creator tax on the output");
    const quote = gross - (gross * 290n) / 10_000n;
    assert.equal(B.quoteSpareOut(POOL, amountIn), quote);
    assert.ok(B.minOutOf(quote) < gross - (gross * 290n) / 10_000n, "minOut sits under what the pool gives after the hook");
    assert.equal(B.minOutOf(quote), (quote * BigInt(10_000 - BURN_MAX_SLIPPAGE_BPS)) / 10_000n);
    assert.ok(quote < (amountIn * 4_000_000n), "price impact: less than the spot price gives");
  });

  test("share = 150 / 500 of the treasury amount; the cap binds and the rest carries over; no read = carry all", () => {
    assert.equal(burnShareOf(parseEther("0.05")), parseEther("0.015"));
    const p = B.planEpochBurn({ toTreasury: parseEther("1"), carryIn: parseEther("0.01"), pool: POOL });
    assert.equal(p.share, parseEther("0.3"));
    assert.equal(p.due, parseEther("0.31"));
    assert.equal(p.cap, parseEther("0.0459"));
    assert.equal(p.buy, parseEther("0.0459"));
    assert.equal(p.carryOut, parseEther("0.31") - parseEther("0.0459"));
    assert.equal(p.minOut, B.minOutOf(B.quoteSpareOut(POOL, p.buy)));
    const small = B.planEpochBurn({ toTreasury: parseEther("0.05"), carryIn: 0n, pool: POOL });
    assert.deepEqual([small.buy, small.carryOut], [parseEther("0.015"), 0n], "under the cap: all of it, nothing carried");
    const none = B.planEpochBurn({ toTreasury: parseEther("1"), carryIn: 5n, pool: null });
    assert.deepEqual([none.buy, none.carryOut, none.cap, none.minOut], [0n, parseEther("0.3") + 5n, null, null]);
  });
});

// A pool key of our own (test values) and its id; the production key is UNISWAP_V4.spareEthPoolKey (src/lib/addresses.ts).
const SPARE = ADDR.spareToken;
const KEY = { currency0: BURN_SINKS.zero, currency1: SPARE, fee: 0x800000, tickSpacing: 200, hooks: getAddress("0x00000000000000000000000000000000000000cc") };
const ROUTER = getAddress("0x00000000000000000000000000000000000000ee");
const INFRA = { ...B.defaultBurnInfra(), router: ROUTER, poolKey: KEY, poolId: B.poolIdOf(KEY) };

describe("the unsigned payload", () => {
  test("Universal Router execute: one V4_SWAP of exactly amountIn ETH, minOut, SPARE taken to the dead address", () => {
    const data = B.encodeBurnSwap({ poolKey: KEY, amountIn: 7n, minOut: 5n, takeTo: "dead", deadline: 99n });
    const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data });
    assert.equal(functionName, "execute");
    const [commands, inputs, deadline] = args;
    assert.equal(commands, "0x10");
    assert.equal(deadline, 99n);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]);
    assert.equal(actions, `0x${[V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
    const [swap] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
      params[0],
    );
    assert.deepEqual(swap.poolKey, KEY);
    assert.deepEqual([swap.zeroForOne, swap.amountIn, swap.amountOutMinimum, swap.minHopPriceX36, swap.hookData], [true, 7n, 5n, 0n, "0x"], "v4-periphery layout of the routers on chain 4663 (minHopPriceX36 0 = off)");
    assert.deepEqual(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]), [BURN_SINKS.zero, 7n], "SETTLE_ALL native ETH, at most amountIn");
    assert.deepEqual(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], params[2]), [SPARE, BURN_SINKS.dead, 0n], "TAKE all SPARE to dead");
  });

  test("the SafeTx hash is Safe's own formula (domain and SafeTx type hashes from the Safe source)", () => {
    const safe = ADDR.treasurySafe;
    const t = { to: ROUTER, value: 7n, data: "0x1234" as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: BURN_SINKS.zero, refundReceiver: BURN_SINKS.zero, nonce: 3n };
    const DOMAIN_TYPEHASH = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218";
    const SAFE_TX_TYPEHASH = "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8";
    assert.equal(keccak256(toBytes("EIP712Domain(uint256 chainId,address verifyingContract)")), DOMAIN_TYPEHASH);
    const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [DOMAIN_TYPEHASH, 4663n, safe]));
    const struct = keccak256(
      encodeAbiParameters(
        ["bytes32", "address", "uint256", "bytes32", "uint8", "uint256", "uint256", "uint256", "address", "address", "uint256"].map((type) => ({ type })),
        [SAFE_TX_TYPEHASH, t.to, t.value, keccak256(t.data), t.operation, 0n, 0n, 0n, t.gasToken, t.refundReceiver, t.nonce],
      ),
    );
    const expected = keccak256(`0x1901${domain.slice(2)}${struct.slice(2)}`);
    assert.equal(B.safeTxHashOf(4663, safe, t), expected);
    assert.notEqual(B.safeTxHashOf(4663, safe, { ...t, nonce: 4n }), expected);
  });
});

describe("plans per charged epoch (scratch DB, chain stubbed)", () => {
  const txOf = (e: number) => pad(`0x${(0xc0 + e).toString(16)}`, { size: 32 });
  const treasury = new Map<string, bigint>();
  const charge = (e: number, toTreasury: bigint, status = "done") => {
    db().prepare("INSERT INTO charges (epoch_id, list_json, list_hash, total_wei, status, tx, created_at, hash_rule) VALUES (?, '[]', ?, '0', ?, ?, 0, 'v2-jobs-merkle')").run(e, pad("0x1", { size: 32 }), status, txOf(e));
    treasury.set(txOf(e).toLowerCase(), toTreasury);
  };
  const plan = (e: number) => db().prepare("SELECT * FROM token_burn_plans WHERE epoch_id = ?").get(e) as Record<string, string | number | null>;
  let executions: { safeTxHash: Hex; txHash: Hex; block: bigint }[] = [];
  before(() => {
    mock.method(tokenChain, "chargedEvent", async (hash: Hex) => {
      const v = treasury.get(hash.toLowerCase());
      return v === undefined ? null : { epochId: 0n, total: v * 20n, toPot: v * 19n, toTreasury: v, block: 1n, txHash: hash };
    });
    mock.method(tokenChain, "headBlock", async () => 500n);
    mock.method(tokenChain, "safeNonce", async () => 11n);
    mock.method(tokenChain, "safeExecutions", async () => executions);
    mock.method(tokenChain, "burnTxContext", async () => ({ to: ADDR.treasurySafe, input: "0x" as Hex, safeExecution: null, ethIn: null, time: 0 }));
  });

  test("burn path not recorded (no StateView, no router, no pool key): incomplete, nothing bought, the whole share carried over", async () => {
    charge(1, parseEther("0.1"));
    charge(2, parseEther("0.2"), "sending"); // not confirmed: not planned
    // The v4 values are recorded in src/lib/addresses.ts since 27 Nov 2026; this is the path for when they are not.
    mock.method(tokenChain, "poolState", async () => {
      throw new m.chainIo.NotLiveError("Uniswap v4 StateView");
    });
    const line = await B.prepareBurns({ ...B.defaultBurnInfra(), router: null, poolKey: null });
    assert.match(line, /epoch 1: incomplete/);
    const p = plan(1);
    assert.equal(p.status, "incomplete");
    assert.equal(p.buy_wei, "0");
    assert.equal(p.share_wei, parseEther("0.03").toString());
    assert.equal(p.carry_out_wei, parseEther("0.03").toString());
    assert.match(String(p.missing), /StateView/);
    assert.equal(p.safe_tx, null);
    assert.equal(plan(2), undefined, "an unconfirmed charge is not planned");
    assert.match(await B.prepareBurns({ ...B.defaultBurnInfra(), router: null, poolKey: null }), /no new charge/);
  });

  test("with the burn path filled in: the cap binds, the plan is prepared and unsigned, the rest carries over", async () => {
    mock.method(tokenChain, "poolState", async () => POOL);
    db().prepare("UPDATE charges SET status = 'done' WHERE epoch_id = 2").run();
    await B.prepareBurns(INFRA);
    const p = plan(2);
    const due = parseEther("0.03") + parseEther("0.06"); // carried from epoch 1 + this share
    assert.equal(p.status, "prepared");
    assert.equal(p.carry_in_wei, parseEther("0.03").toString());
    assert.equal(p.due_wei, due.toString());
    assert.equal(p.cap_wei, parseEther("0.0459").toString());
    assert.equal(p.buy_wei, parseEther("0.0459").toString());
    assert.equal(p.carry_out_wei, (due - parseEther("0.0459")).toString());
    assert.equal(p.deadline, Math.floor(clockMs / 1000) + BURN_PAYLOAD_TTL_SECONDS);
    const tx = JSON.parse(String(p.safe_tx)) as { unsigned: boolean; safeTx: { to: string; value: string; data: Hex; operation: number; nonce: string }; safeTxHash: Hex; builder: { transactions: { to: string; value: string; data: Hex }[] } };
    assert.equal(tx.unsigned, true);
    assert.deepEqual([tx.safeTx.to, tx.safeTx.value, tx.safeTx.operation, tx.safeTx.nonce], [ROUTER, parseEther("0.0459").toString(), 0, "11"]);
    assert.equal(tx.safeTxHash, p.safe_tx_hash);
    assert.equal(keccak256(tx.safeTx.data), p.data_hash);
    assert.deepEqual(tx.builder.transactions, [{ to: ROUTER, value: parseEther("0.0459").toString(), data: tx.safeTx.data, contractMethod: null, contractInputsValues: null }]);
    assert.equal(p.min_out_wei, B.minOutOf(B.quoteSpareOut(POOL, parseEther("0.0459"))).toString());
  });

  test("a pool key that does not hash to the recorded pool id is refused", async () => {
    charge(3, parseEther("0.01"));
    await B.prepareBurns({ ...INFRA, poolId: UNISWAP_V4.spareEthPoolId });
    assert.equal(plan(3).status, "incomplete");
    assert.match(String(plan(3).missing), /does not hash to the recorded SPARE\/ETH pool id/);
  });

  test("not executed before its deadline: expired, and its buy is carried into the next plan", async () => {
    clockMs += (BURN_PAYLOAD_TTL_SECONDS + 60) * 1000;
    charge(4, parseEther("0.01"));
    await B.prepareBurns(INFRA);
    assert.equal(plan(2).status, "expired");
    const expected = BigInt(String(plan(3).carry_out_wei)) + parseEther("0.0459");
    assert.equal(plan(4).carry_in_wei, expected.toString());
  });

  test("found executed by the treasury Safe (SafeTx hash in ExecutionSuccess): executed, nothing carried back", async () => {
    executions = [{ safeTxHash: String(plan(4).safe_tx_hash) as Hex, txHash: pad("0xbeef", { size: 32 }), block: 600n }];
    charge(5, parseEther("0.01"));
    await B.prepareBurns(INFRA);
    assert.equal(plan(4).status, "executed");
    assert.equal(plan(4).executed_tx, pad("0xbeef", { size: 32 }));
    assert.equal(plan(5).carry_in_wei, plan(4).carry_out_wei);
    const reasons = B.carryRows().map((c) => [c.epochId, c.reason]);
    assert.deepEqual(reasons.slice(0, 3), [
      [1, "carried over (burn path not live)"],
      [2, "carried over (not executed before its deadline)"],
      [3, "carried over (burn path not live)"],
    ]);
  });

  test("public rows: only burn transfers in treasury Safe transactions, each with its hash; the total is their sum", async () => {
    const safeTx = pad("0xbeef", { size: 32 });
    const userTx = pad("0xf00d", { size: 32 });
    mock.method(tokenChain, "spareBurnTransfers", async () => [
      { block: 600n, logIndex: 1, txHash: safeTx, from: getAddress("0x00000000000000000000000000000000000b0001"), to: BURN_SINKS.dead, value: 1_000n },
      { block: 600n, logIndex: 2, txHash: safeTx, from: getAddress("0x00000000000000000000000000000000000b0001"), to: BURN_SINKS.dead, value: 234n },
      { block: 650n, logIndex: 0, txHash: userTx, from: getAddress("0x0000000000000000000000000000000000000b0b"), to: BURN_SINKS.zero, value: 9_999n },
    ]);
    mock.method(tokenChain, "burnTxContext", async (hash: Hex) =>
      hash === safeTx
        ? { to: ADDR.treasurySafe, input: "0x" as Hex, safeExecution: String(plan(4).safe_tx_hash) as Hex, ethIn: parseEther("0.0459"), time: 1_800_000_000 }
        : { to: getAddress("0x0000000000000000000000000000000000000b0b"), input: "0x" as Hex, safeExecution: null, ethIn: null, time: 1_800_000_100 },
    );
    const { rows, burner, stakeLive } = await B.readBurnRows(1n);
    assert.equal(rows.length, 1, "someone else's burn is not a Sparecycle burn");
    assert.deepEqual([rows[0].txHash, rows[0].spareBurned, rows[0].ethIn, rows[0].epochId, rows[0].path], [safeTx, 1_234n, parseEther("0.0459"), 4, "2a"]);
    assert.ok(rows.every((r) => /^0x[0-9a-f]{64}$/.test(r.txHash)), "no burn row without a transaction hash");
    assert.equal(rows.reduce((s, r) => s + r.spareBurned, 0n), 1_234n);
    assert.equal(burner, "not-live");
    assert.equal(stakeLive, true, "SparecycleNodeStake is deployed (26 Nov 2026)");
  });

  test("the 'burn' method batches the swap (SPARE to the Safe) and burn(minOut + what the Safe holds) through MultiSend", async () => {
    mock.method(tokenChain, "spareBalanceOf", async () => 77n);
    charge(6, parseEther("0.01"));
    await B.prepareBurns({ ...INFRA, method: "burn" });
    assert.match(String(plan(6).missing), /MultiSendCallOnly/, "no MultiSendCallOnly recorded: incomplete");
    charge(7, parseEther("0.01"));
    const multiSend = getAddress("0x00000000000000000000000000000000000000ab");
    await B.prepareBurns({ ...INFRA, method: "burn", multiSend });
    const tx = JSON.parse(String(plan(7).safe_tx)) as { safeTx: { to: string; operation: number; value: string }; builder: { transactions: { to: string; data: Hex }[] } };
    assert.deepEqual([tx.safeTx.to, tx.safeTx.operation, tx.safeTx.value], [multiSend, 1, "0"]);
    const burn = decodeFunctionData({ abi: spareTokenAbi, data: tx.builder.transactions[1].data });
    assert.equal(burn.functionName, "burn");
    assert.equal(burn.args[0], BigInt(String(plan(7).min_out_wei)) + 77n);
  });
});

test("no token module can sign or send: no wallet client, key or write call in any of them", () => {
  const files = ["burns.ts", "holders.ts", "slashing.ts", "stake-gate.ts", "holder-page.ts", "token-work.ts"];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dirname, f), "utf8");
    for (const bad of ["createWalletClient", "writeContract", "sendTransaction", "sendRawTransaction", "signTransaction", "signTypedData", "privateKeyToAccount", "schedulerAccount", "signerKey"]) {
      assert.ok(!src.includes(bad), `${f} uses ${bad}`);
    }
  }
  const io = readFileSync(join(import.meta.dirname, "chain-io.ts"), "utf8");
  const tokenPart = io.slice(io.indexOf("export const tokenChain"));
  for (const bad of ["createWalletClient", "writeContract", "sendTransaction", "simulateContract"]) assert.ok(!tokenPart.includes(bad), `tokenChain uses ${bad}`);
});

