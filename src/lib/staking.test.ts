// The pure parts of node staking (src/lib/staking.ts): SPARE amounts typed and shown, the cooldown / appeal windows as
// SparecycleNodeStake._windowOver decides them, the wait wording and the error sentences. Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, UserRejectedRequestError } from "viem";
import { nodeStakeAbi } from "./token-contracts";
import { FORBIDDEN_TOKEN_WORDS } from "./token-rules";
import {
  epochsLabel,
  explainStakeTxError,
  formatSpare,
  formatWait,
  parseEvidenceHash,
  parseSpareInput,
  proposalStatusName,
  spareInputValue,
  windowState,
  type WindowInput,
} from "./staking";

const E18 = 10n ** 18n;

describe("SPARE amounts", () => {
  test("parseSpareInput takes plain positive decimals with up to 18 decimals", () => {
    assert.equal(parseSpareInput("1"), E18);
    assert.equal(parseSpareInput(" 12.5 "), 12n * E18 + E18 / 2n);
    assert.equal(parseSpareInput(".25"), E18 / 4n);
    assert.equal(parseSpareInput("3."), 3n * E18);
    assert.equal(parseSpareInput("0.000000000000000001"), 1n);
    assert.equal(parseSpareInput("1000000000"), 1_000_000_000n * E18);
  });

  test("parseSpareInput refuses zero, signs, exponents, separators, too many decimals and words", () => {
    for (const bad of ["", "0", "0.0", "-1", "+1", "1e3", "1,000", "1 000", "0.0000000000000000001", "abc", "1.2.3", "Infinity", "0x10"]) {
      assert.equal(parseSpareInput(bad), null, JSON.stringify(bad));
    }
  });

  test("formatSpare cuts (never rounds up), groups thousands and never shows a positive amount as 0", () => {
    assert.equal(formatSpare(0n), "0");
    assert.equal(formatSpare(1234n * E18), "1,234");
    assert.equal(formatSpare(1234n * E18 + (E18 * 56789n) / 100000n), "1,234.5678");
    assert.equal(formatSpare(E18 - 1n), "0.9999", "0.999…9 is cut to 0.9999, not rounded to 1");
    assert.equal(formatSpare(E18 / 2n, 2), "0.5");
    assert.equal(formatSpare(1n), "< 0.0001");
    assert.equal(formatSpare(10n ** 13n, 2), "< 0.01");
    assert.equal(formatSpare(-5n * E18), "-5");
  });

  test("spareInputValue gives the exact amount back for an input field", () => {
    for (const v of [1n, E18, 12n * E18 + E18 / 2n, 1_000_000n * E18 + 1n]) assert.equal(parseSpareInput(spareInputValue(v)), v);
    assert.equal(spareInputValue(12n * E18 + E18 / 2n), "12.5");
    assert.equal(spareInputValue(7n * E18), "7");
  });
});

describe("windowState mirrors SparecycleNodeStake._windowOver", () => {
  // A 16-epoch cooldown requested at t = 1_000_000 in epoch 100, 6-hour epochs.
  const L = 21_600n;
  const base: WindowInput = {
    startEpoch: 100n,
    startAt: 1_000_000n,
    epochs: 16n,
    epochLength: L,
    stallFactor: 2n,
    currentEpoch: 100n,
    currentEpochStartedAt: 990_000n,
    now: 1_000_000,
  };
  const span = 16 * 21_600;

  test("just requested: not over, ends no earlier than start + 16 x epochLength, at the latest after twice that", () => {
    const w = windowState(base);
    assert.equal(w.over, false);
    assert.equal(w.targetEpoch, 116n);
    assert.equal(w.epochsLeft, 16n);
    assert.equal(w.notBefore, 1_000_000 + span);
    assert.equal(w.latest, 1_000_000 + 2 * span);
    // epoch 100 started 10 000 s before the request, so 16 closes on schedule land before notBefore: notBefore wins.
    assert.equal(w.expected, 1_000_000 + span);
    assert.equal(w.waitingForEpochs, false);
  });

  test("epochs closing late push the estimate out, never past the stall bound", () => {
    const late = windowState({ ...base, now: 1_100_000, currentEpoch: 101n, currentEpochStartedAt: 1_090_000n });
    assert.equal(late.expected, 1_090_000 + 15 * 21_600);
    const stalled = windowState({ ...base, now: 1_200_000, currentEpoch: 101n, currentEpochStartedAt: 1_190_000n });
    assert.equal(stalled.expected, Math.min(1_190_000 + 15 * 21_600, 1_000_000 + 2 * span));
  });

  test("time passed and 16 epochs closed: over", () => {
    const w = windowState({ ...base, now: 1_000_000 + span, currentEpoch: 116n });
    assert.equal(w.over, true);
    assert.equal(w.expected, null);
    assert.equal(w.epochsLeft, 0n);
  });

  test("16 epochs closed but not 16 x epochLength of time yet: not over (the time part is a floor)", () => {
    const w = windowState({ ...base, now: 1_000_000 + span - 1, currentEpoch: 130n });
    assert.equal(w.over, false);
    assert.equal(w.expected, 1_000_000 + span);
  });

  test("time passed, epochs not closed: waiting for epochs until the stall fallback, then over", () => {
    const waiting = windowState({ ...base, now: 1_000_000 + span + 5, currentEpoch: 110n, currentEpochStartedAt: BigInt(1_000_000 + span - 100) });
    assert.equal(waiting.over, false);
    assert.equal(waiting.waitingForEpochs, true);
    assert.equal(waiting.epochsLeft, 6n);
    const stalled = windowState({ ...base, now: 1_000_000 + 2 * span, currentEpoch: 110n });
    assert.equal(stalled.over, true, "STALL_FACTOR x span after the start the window is over without the epochs");
  });

  test("no estimate without the current epoch's start, but the bounds stay", () => {
    const w = windowState({ ...base, currentEpochStartedAt: null });
    assert.equal(w.expected, null);
    assert.equal(w.notBefore, 1_000_000 + span);
  });
});

describe("wording", () => {
  test("formatWait is approximate and plain", () => {
    assert.equal(formatWait(0), "less than a minute");
    assert.equal(formatWait(59), "less than a minute");
    assert.equal(formatWait(60), "about 1 min");
    assert.equal(formatWait(35 * 60 + 20), "about 35 min");
    assert.equal(formatWait(3600), "about 1 h");
    assert.equal(formatWait(5 * 3600 + 20 * 60), "about 5 h 20 min");
    assert.equal(formatWait(30 * 3600), "about 30 h");
    assert.equal(formatWait(4 * 86_400), "about 4 days");
    assert.equal(formatWait(4 * 86_400 + 2 * 3600 + 59), "about 4 days 2 h");
    assert.equal(formatWait(-10), "less than a minute");
  });

  test("epochsLabel names the minimum time of a window", () => {
    assert.equal(epochsLabel(16n, 21_600n), "16 epochs (at least 4 days)");
    assert.equal(epochsLabel(2, 21_600), "2 epochs (at least 12 h)");
    assert.equal(epochsLabel(1, 21_600), "1 epoch (at least 6 h)");
    assert.equal(epochsLabel(4, null), "4 epochs");
  });

  test("proposal status by number", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(proposalStatusName), ["None", "Open", "Cancelled", "Executed", "Expired"]);
    assert.equal(proposalStatusName(9), "Unknown");
  });

  test("parseEvidenceHash takes a non-zero 32-byte hex hash", () => {
    const h = `0x${"ab".repeat(32)}`;
    assert.equal(parseEvidenceHash(` ${h.toUpperCase().replace("0X", "0x")} `), h);
    for (const bad of ["", "0x", `0x${"00".repeat(32)}`, `0x${"ab".repeat(31)}`, `${"ab".repeat(32)}`, `0x${"zz".repeat(32)}`]) assert.equal(parseEvidenceHash(bad), null, bad);
  });
});

describe("the staking copy", () => {
  const FILES = [
    "src/lib/staking.ts",
    "src/server/staking.ts",
    "src/lib/openapi-staking.ts",
    "src/components/dapp/stake-panel.tsx",
    "src/components/dapp/staking-numbers.tsx",
    "src/app/(dapp)/nodes/stake/page.tsx",
    "src/app/(site)/docs/run-a-node/page.tsx",
  ];
  const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", f), "utf8");

  test("never uses the words of brief §9.3 (staking pays nothing)", () => {
    for (const f of FILES) {
      const text = read(f).toLowerCase();
      for (const w of FORBIDDEN_TOKEN_WORDS) {
        assert.ok(!new RegExp(`\\b${w}${w === "earn" ? "(s|ed|ing)?" : ""}\\b`).test(text), `"${w}" in ${f}`);
      }
      assert.ok(!/rewards? for staking|staking rewards?/.test(text), `staking rewards in ${f}`);
    }
  });

  test("says it is voluntary, pays nothing, and is not externally audited", () => {
    const page = read("src/app/(dapp)/nodes/stake/page.tsx");
    assert.match(page, /minimum per node is 0/);
    assert.match(page, /pays nothing/);
    assert.match(page, /internal review only/i);
    assert.match(page, /restarts the cooldown/);
    assert.match(read("src/components/dapp/stake-panel.tsx"), /This restarts the whole cooldown/);
  });
});

describe("explainStakeTxError", () => {
  const reverted = (errorName: string, args: unknown[] = []) => {
    const data = encodeErrorResult({ abi: nodeStakeAbi, errorName: errorName as "CooldownNotOver", args: args as [] });
    const cause = new ContractFunctionRevertedError({ abi: nodeStakeAbi, data, functionName: "unstake" });
    return new ContractFunctionExecutionError(cause, { abi: nodeStakeAbi, functionName: "unstake", args: [], contractAddress: "0x0000000000000000000000000000000000000001" });
  };

  test("names the contract's refusals in plain words", () => {
    assert.match(explainStakeTxError(reverted("CooldownNotOver")), /cooldown is not over/);
    assert.match(explainStakeTxError(reverted("StakeFrozen", [3n])), /proposal against this wallet is open/);
    assert.match(explainStakeTxError(reverted("AppealWindowOver", [3n])), /appeal window/);
    assert.match(explainStakeTxError(reverted("InsufficientStake", [1n, 2n])), /more than your active stake/);
  });

  test("a wallet rejection says nothing was sent", () => {
    assert.match(explainStakeTxError(new BaseError("x", { cause: new UserRejectedRequestError(new Error("rejected")) })), /rejected the request/);
  });
});
