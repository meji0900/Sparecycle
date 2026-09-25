// Sweep / claim bot: moves trading fees that already exist toward the reward contract, and alerts a human
// whenever it can't. It never skips silently.
//
//   1. Pons curve (pre-graduation): if quoteFeeBalance() / creatorTaxBalance() > 0, sweep through the Pons fee-sweep
//      operator: read it live from hook.feeSweepOperator(), then call operator.sweepCurve(curve). The curve's own
//      sweepFees(uint256) is NOT used: it reverts NotFeeSweepOperator() for everyone except the creatorFeeRecipient
//      (the reward contract, which has no sweep function) and the operator. Operator reverts (access changed,
//      paused, base-fee limits, …) are reported as alerts, never fatal.
//   2. Pons hook (post-graduation, UNVERIFIED: not exercised on a fork): pendingFees / pendingCreatorTax for
//      SWEEP_POOL_ID -> sweepPoolFees(poolId, 0, 0).
//   3. Fee escrow -> reward contract: if the reward contract is the creator fee recipient, read the escrow balance
//      first (the real escrow reverts NoBalance() on an empty claim) and call the permissionless
//      claimFeesFromEscrow() (ETH) / claimFeesFromEscrowToken() (ERC-20) only when it is non-zero. If the multisig
//      is the recipient (fallback), print an ALERT with the amount the multisig must claim and forward with
//      fund() / fundToken().
//
// Verified on a Robinhood Chain mainnet fork (contracts/test/fork/PonsEscrowFork.t.sol, contracts/README.md):
// the operator path sweepCurve(curve) -> claimFeesFromEscrow() works from a random EOA as of 20 Nov 2026.
// Selectors below come from that fork test (deployed bytecode), not from the Pons docs; `--self-check` asserts them.
//
// Dry-run by default: reads and simulations only. `--send` transacts from SWEEP_SIGNER_KEY (never logged);
// SWEEP_ENABLED=0 is a kill switch that refuses --send. Run by scripts/sweep.mjs.
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { config } from "@/lib/config";
import { publicClient, targetChain } from "@/lib/chain";
import { LAUNCH_PHASES, PONS, ponsCurveAbi, ponsEscrowAbi, ponsFactoryAbi, ponsHookAbi } from "@/lib/pons";
import { sparecycleRewardsAbi } from "@/contracts/sparecycleRewards";

/** Selectors observed in deployed bytecode by contracts/test/fork/PonsEscrowFork.t.sol. */
export const FORK_SELECTORS = {
  "feeSweepOperator()": "0x8a36a6bb", // hook
  "sweepCurve(address)": "0xe6b71b11", // Pons fee-sweep operator
  "quoteFeeBalance()": "0xed479c47", // curve
  "creatorTaxBalance()": "0xdb2bd533", // curve
  "NotFeeSweepOperator()": "0x8d42130c", // curve error
  "NoBalance()": "0xc2caa2a6", // escrow error
} as const;

/** Errors with fork-verified selectors (decoded when they revert). Others are reported by raw selector. */
const ponsErrors = parseAbi(["error NotFeeSweepOperator()", "error NoBalance()"]);
const curveAbi = [...ponsCurveAbi, ...ponsErrors] as const;
const hookAbi = [...ponsHookAbi, ...parseAbi(["function feeSweepOperator() view returns (address)"]), ...ponsErrors] as const;
// floor(address) / BelowFloor() read from the live operator's bytecode on 24 Nov 2026 (selectors 0xe79df733 /
// 0x4e7e2916): the minimum curve balance, per pair token, that sweepCurve accepts. 0.0037 ETH for ETH pairs then.
const operatorAbi = [
  ...parseAbi(["function sweepCurve(address curve)", "function floor(address pairToken) view returns (uint256)", "error BelowFloor()"]),
  ...ponsErrors,
] as const;
const rewardsAbi = [...sparecycleRewardsAbi, ...ponsErrors] as const;

/** Pure check that the ABI fragments above hash to the fork-verified selectors. */
export function selfCheck(): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const [sig, want] of Object.entries(FORK_SELECTORS)) {
    const got = toFunctionSelector(sig);
    const pass = got === want;
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${sig} = ${got}${pass ? "" : ` (fork test says ${want})`}`);
  }
  return { ok, lines };
}

export type SweepReport = {
  configured: boolean;
  mode: "dry-run" | "send";
  lines: string[];
  alerts: string[];
  errors: string[];
  txs: Hex[];
};

/** Secret-free error text: decoded revert name, else the raw 4-byte selector, else viem's short message. */
const short = (e: unknown) => {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      if (r.data?.errorName) return `reverted ${r.data.errorName}`;
      if (r.reason) return `reverted: ${r.reason}`;
      if (r.signature) return `reverted with undecoded error ${r.signature}`;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
};

const amount = (wei: bigint, asset: Address | null) =>
  !asset || asset === zeroAddress ? `${formatEther(wei)} ETH (${wei} wei)` : `${wei} base units of ${asset}`;

export async function runSweep(opts: { send: boolean }): Promise<SweepReport> {
  const report: SweepReport = { configured: false, mode: opts.send ? "send" : "dry-run", lines: [], alerts: [], errors: [], txs: [] };
  const line = (s: string) => report.lines.push(s);
  const alert = (s: string) => report.alerts.push(s);

  line(`network ${config.network} (chain ${targetChain.id}), RPC ${targetChain.rpcUrls.default.http[0]}`);
  line(`mode: ${report.mode}${opts.send ? "" : " (pass --send to transact)"}`);

  // SWEEP_TOKEN_ADDRESS / SWEEP_CURVE_ADDRESS: the token whose creator fees go to the reward contract, when the
  // site's official token sends its fees elsewhere.
  const envAddr = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? (v.trim() as Address) : null);
  const token = envAddr(process.env.SWEEP_TOKEN_ADDRESS) ?? config.tokenAddress;
  const reward = config.rewardContract;
  const multisig = config.multisig;
  if (!token && !config.curveAddress && !envAddr(process.env.SWEEP_CURVE_ADDRESS) && !reward && !multisig) {
    line(
      "not configured: none of NEXT_PUBLIC_TOKEN_ADDRESS, NEXT_PUBLIC_CURVE_ADDRESS, NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS, " +
        "NEXT_PUBLIC_MULTISIG_ADDRESS is set. Nothing to sweep or claim.",
    );
    return report;
  }
  report.configured = true;

  // Signer (only for --send).
  let signer: PrivateKeyAccount | null = null;
  if (opts.send) {
    const killed = ["0", "false", "off"].includes((process.env.SWEEP_ENABLED ?? "").trim().toLowerCase());
    const key = process.env.SWEEP_SIGNER_KEY?.trim();
    if (killed) report.errors.push("SWEEP_ENABLED=0: --send refused (kill switch). Running as dry-run.");
    else if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) report.errors.push("--send needs SWEEP_SIGNER_KEY (0x + 64 hex). Running as dry-run.");
    else signer = privateKeyToAccount(key as Hex);
    if (signer) line(`signer ${signer.address}`);
    else report.mode = "dry-run";
  }
  const wallet = signer
    ? createWalletClient({ account: signer, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) })
    : null;

  /**
   * Simulates (from the signer, else NEXT_PUBLIC_SWEEP_BOT_ADDRESS, else the zero address — every call made here
   * is permissionless), then in send mode sends and waits. Returns whether it (would have) succeeded; a revert is
   * reported through `onRevert` (default: an error line), never thrown.
   */
  const act = async (
    label: string,
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    onRevert: (msg: string) => void = (msg) => report.errors.push(`${label}: ${msg}`),
  ): Promise<boolean> => {
    const from = signer?.address ?? config.sweepBotAddress ?? zeroAddress;
    try {
      // Simulate with the local account object when there is one, so the write is signed here and sent raw
      // (an address string would make viem ask the RPC to sign: eth_sendTransaction, which real RPCs refuse).
      const sim = await publicClient.simulateContract({ account: signer ?? from, address, abi, functionName, args });
      if (!wallet || !signer) {
        line(`  dry-run: ${label} would succeed (simulated from ${from})`);
        return true;
      }
      const hash = await wallet.writeContract({ ...(sim.request as Parameters<typeof wallet.writeContract>[0]), account: signer });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      report.txs.push(hash);
      if (rcpt.status === "success") {
        line(`  sent: ${label} -> ${hash}`);
        return true;
      }
      onRevert(`transaction ${hash} reverted`);
      return false;
    } catch (e) {
      onRevert(short(e));
      return false;
    }
  };

  // ---- 1/2: unswept fees on the curve or the hook ----------------------------------------------------
  let curve = envAddr(process.env.SWEEP_CURVE_ADDRESS) ?? (envAddr(process.env.SWEEP_TOKEN_ADDRESS) ? null : config.curveAddress);
  let pairToken: Address | null = config.pairTokenAddress;
  let recipient: Address | null = null;
  let phase: number | null = null;
  if (token) {
    try {
      const t = await publicClient.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token] });
      if (!t.exists) {
        alert(`the Pons factory does not know token ${token}`);
      } else {
        phase = t.phase;
        pairToken = t.pairToken;
        recipient = t.creatorFeeRecipient;
        if (curve && curve.toLowerCase() !== t.curve.toLowerCase()) alert(`NEXT_PUBLIC_CURVE_ADDRESS ${curve} != factory curve ${t.curve}`);
        curve = t.curve;
        line(`token ${token}: phase ${phase} (${LAUNCH_PHASES[phase] ?? "unknown"}), curve ${t.curve}, creator fee recipient ${t.creatorFeeRecipient}`);
      }
    } catch (e) {
      report.errors.push(`factory.getLaunchedToken(${token}): ${short(e)}`);
    }
  } else if (curve) {
    line(`token address not set; using NEXT_PUBLIC_CURVE_ADDRESS ${curve} (phase unknown)`);
  } else {
    line("token and curve not set: no unswept-fee check");
  }

  if (curve && (phase === null || phase === 0)) {
    let pending = 0n;
    let readable = 0;
    for (const fn of ["quoteFeeBalance", "creatorTaxBalance"] as const) {
      try {
        const v = await publicClient.readContract({ address: curve, abi: curveAbi, functionName: fn });
        line(`curve ${fn}() = ${amount(v, pairToken)}`);
        pending += v;
        readable++;
      } catch (e) {
        alert(`curve ${fn}() unreadable (${short(e)}); check the curve manually`);
      }
    }
    if (pending > 0n) {
      let operator: Address | null = null;
      try {
        operator = await publicClient.readContract({ address: PONS.memeHook, abi: hookAbi, functionName: "feeSweepOperator" });
        line(`Pons fee-sweep operator (live from hook.feeSweepOperator()): ${operator}`);
      } catch (e) {
        alert(`hook.feeSweepOperator() unreadable (${short(e)}): can't sweep ${amount(pending, pairToken)} on the curve; ask Pons or sweep as the creatorFeeRecipient`);
      }
      // The operator refuses sweeps below a per-pair minimum (BelowFloor()); fees simply wait on the curve until then.
      let floor: bigint | null = null;
      if (operator && operator !== zeroAddress) {
        try {
          floor = await publicClient.readContract({ address: operator, abi: operatorAbi, functionName: "floor", args: [pairToken ?? zeroAddress] });
        } catch {
          floor = null; // older operator without floor(): just try the sweep
        }
      }
      if (operator && operator !== zeroAddress && floor !== null && pending < floor) {
        line(`curve: ${amount(pending, pairToken)} waiting; the Pons operator sweeps from ${amount(floor, pairToken)} (operator.floor), nothing lost`);
      } else if (operator && operator !== zeroAddress) {
        await act(`operator.sweepCurve(${curve})`, operator, operatorAbi as unknown as Abi, "sweepCurve", [curve], (msg) =>
          /BelowFloor/.test(msg)
            ? line(`curve: ${amount(pending, pairToken)} is below the Pons sweep minimum (BelowFloor); waiting, nothing lost`)
            : alert(
                `operator.sweepCurve reverted (${msg}): ${amount(pending, pairToken)} stays unswept on the curve. ` +
                  "Operator access may have changed (trusted-sweeper list, pause, base-fee limit); the creatorFeeRecipient or the Pons operator must sweep",
              ),
        );
      } else if (operator === zeroAddress) {
        alert(`hook.feeSweepOperator() is the zero address: ${amount(pending, pairToken)} stays unswept on the curve`);
      }
    } else if (readable > 0) {
      line("curve: nothing to sweep");
    }
  }
  if (phase !== null && phase >= 1) {
    line("post-graduation hook path: UNVERIFIED (not exercised on a mainnet fork yet)");
    const poolId = process.env.SWEEP_POOL_ID?.trim();
    if (!poolId || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
      alert("poolId not set: set SWEEP_POOL_ID (bytes32) to check post-graduation fees on the Pons hook");
    } else {
      const currency = pairToken ?? zeroAddress;
      let pending = 0n;
      for (const fn of ["pendingFees", "pendingCreatorTax"] as const) {
        try {
          const v = await publicClient.readContract({ address: PONS.memeHook, abi: hookAbi, functionName: fn, args: [poolId as Hex, currency] });
          line(`hook ${fn}(${poolId.slice(0, 10)}…) = ${amount(v, currency)}`);
          pending += v;
        } catch (e) {
          report.errors.push(`hook ${fn}: ${short(e)}`);
        }
      }
      if (pending > 0n) {
        await act("hook.sweepPoolFees(poolId, 0, 0) [unverified path]", PONS.memeHook, hookAbi as unknown as Abi, "sweepPoolFees", [poolId, 0n, 0n], (msg) =>
          alert(`hook.sweepPoolFees reverted (${msg}): ${amount(pending, currency)} stays unswept on the hook`),
        );
      } else line("hook: nothing to sweep");
    }
  }

  // ---- 3: escrow -> reward contract (or alert the multisig) ---------------------------------------
  let escrow: Address = PONS.feeEscrow;
  let payoutToken: Address | null = null;
  if (reward) {
    try {
      [escrow, payoutToken] = await Promise.all([
        publicClient.readContract({ address: reward, abi: sparecycleRewardsAbi, functionName: "feeEscrow" }),
        publicClient.readContract({ address: reward, abi: sparecycleRewardsAbi, functionName: "payoutToken" }),
      ]);
      const unacc = await publicClient.readContract({ address: reward, abi: sparecycleRewardsAbi, functionName: "unaccounted" });
      line(`reward contract ${reward}: escrow ${escrow}, payout ${payoutToken === zeroAddress ? "ETH" : payoutToken}`);
      if (unacc > 0n) line(`reward contract holds ${amount(unacc, payoutToken)} not yet credited (credited by sync() / at epoch close)`);
    } catch (e) {
      report.errors.push(`reward contract reads: ${short(e)}`);
    }
  }
  const effectiveRecipient = recipient ?? reward ?? multisig;
  if (!recipient && effectiveRecipient) {
    line(`creator fee recipient unknown (token not set); assuming ${effectiveRecipient === reward ? "the reward contract" : "the multisig"}`);
  }
  if (!wallet) line("note: in dry-run a curve sweep is only simulated, so the escrow balance below does not include it yet");

  if (reward && effectiveRecipient && effectiveRecipient.toLowerCase() === reward.toLowerCase()) {
    try {
      const eth = !payoutToken || payoutToken === zeroAddress;
      const bal = eth
        ? await publicClient.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOf", args: [reward] })
        : await publicClient.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOfToken", args: [reward, payoutToken!] });
      line(`escrow ${eth ? "balanceOf" : "balanceOfToken"}(reward contract) = ${amount(bal, eth ? null : payoutToken)}`);
      if (bal === 0n) {
        line(`escrow: balance is 0, skipping ${eth ? "claimFeesFromEscrow()" : "claimFeesFromEscrowToken()"} (the escrow reverts NoBalance() on an empty claim)`);
      } else if (eth) {
        await act("rewards.claimFeesFromEscrow()", reward, rewardsAbi as unknown as Abi, "claimFeesFromEscrow", []);
      } else {
        await act("rewards.claimFeesFromEscrowToken()", reward, rewardsAbi as unknown as Abi, "claimFeesFromEscrowToken", []);
      }
    } catch (e) {
      report.errors.push(`escrow reads: ${short(e)}`);
    }
  } else if (multisig && effectiveRecipient && effectiveRecipient.toLowerCase() === multisig.toLowerCase()) {
    try {
      const eth = await publicClient.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOf", args: [multisig] });
      const tok =
        pairToken && pairToken !== zeroAddress
          ? await publicClient.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOfToken", args: [multisig, pairToken] })
          : 0n;
      line(`fallback active: the multisig ${multisig} is the creator fee recipient`);
      line(`escrow balanceOf(multisig) = ${amount(eth, null)}${pairToken && pairToken !== zeroAddress ? `, balanceOfToken = ${amount(tok, pairToken)}` : ""}`);
      if (eth > 0n) {
        alert(`multisig must claim ${amount(eth, null)} with escrow.claim() and forward it to the reward contract with fund()`);
      }
      if (tok > 0n) {
        alert(`multisig must claim ${amount(tok, pairToken)} with escrow.claimToken(${pairToken}) and forward it with fundToken()`);
      }
      if (eth === 0n && tok === 0n) line("escrow: nothing waiting for the multisig");
    } catch (e) {
      report.errors.push(`escrow reads: ${short(e)}`);
    }
  } else if (recipient) {
    alert(`creator fee recipient ${recipient} is neither the reward contract nor the multisig: fees are not reaching the pot`);
  } else {
    alert("no reward contract and no multisig configured: escrowed fees can't be routed to a pot");
  }
  return report;
}

export function printReport(r: SweepReport) {
  const stamp = new Date().toISOString();
  console.log(`[sweep ${stamp}] Sparecycle sweep bot`);
  for (const l of r.lines) console.log(`  ${l}`);
  for (const a of r.alerts) console.log(`  ALERT: ${a}`);
  for (const e of r.errors) console.log(`  ERROR: ${e}`);
  if (r.configured && !r.alerts.length && !r.errors.length) console.log("  ok");
}

/** CLI entry (scripts/sweep.mjs): [--send] [--interval <seconds>] | --self-check. Exit 1 when a run had errors. */
export async function runSweepCli(argv: string[]) {
  if (argv.includes("--self-check")) {
    const c = selfCheck();
    console.log(`[sweep] self-check: ABI fragments vs selectors from contracts/test/fork/PonsEscrowFork.t.sol`);
    for (const l of c.lines) console.log(`  ${l}`);
    return c.ok ? 0 : 1;
  }
  const send = argv.includes("--send");
  const i = argv.indexOf("--interval");
  const interval = i >= 0 ? Number(argv[i + 1]) : 0;
  if (i >= 0 && !(Number.isFinite(interval) && interval >= 10)) throw new Error("--interval needs a number of seconds >= 10");
  for (;;) {
    let failed = false;
    try {
      const r = await runSweep({ send });
      printReport(r);
      failed = r.errors.length > 0;
    } catch (e) {
      console.log(`  ERROR: ${short(e)}`);
      failed = true;
    }
    if (!interval) return failed ? 1 : 0;
    await new Promise((res) => setTimeout(res, interval * 1000));
  }
}

// ---- Always-on mode inside the web server ----------------------------------------------------------------
// SWEEP_AUTORUN_MINUTES=N (N >= 5) runs runSweep({ send: true }) every N minutes from bootScheduler(). It only
// transacts when fees are waiting (the curve or the escrow holds a balance), so idle runs cost nothing. The last
// result is kept in memory for /api/health; ALERT_WEBHOOK_URL (Discord or Slack incoming webhook) receives a
// message whenever the set of problems changes, including a bot wallet running low on gas.

/** Below this a bot wallet gets a low-gas alert (≈ 50 sweeps or root posts at today's 0.02 gwei). */
const LOW_GAS_WEI = 50_000_000_000_000n; // 0.00005 ETH

export type SweepStatus = { at: string; ok: boolean; mode: SweepReport["mode"]; alerts: string[]; errors: string[]; txs: Hex[] };
const sg = globalThis as typeof globalThis & {
  __sparecycleSweepTimer?: ReturnType<typeof setInterval>;
  __sparecycleSweepLast?: SweepStatus;
  __sparecycleSweepNotified?: string;
};

/** Last automatic run (null when the timer is off or has not run yet). Secret-free. */
export const lastSweepStatus = (): SweepStatus | null => sg.__sparecycleSweepLast ?? null;

const autorunMinutes = (): number => {
  const n = Number((process.env.SWEEP_AUTORUN_MINUTES ?? "").trim());
  return Number.isInteger(n) && n >= 5 ? n : 0;
};

/** Gas balances of the two hot wallets (sweep signer, scheduler root poster); low ones become alerts. */
async function lowGasAlerts(): Promise<string[]> {
  const out: string[] = [];
  const wallets: [string, string | undefined][] = [
    ["sweep bot", process.env.SWEEP_SIGNER_KEY],
    ["scheduler", process.env.SCHEDULER_SIGNER_KEY],
  ];
  for (const [label, key] of wallets) {
    const k = key?.trim();
    if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) continue;
    const address = privateKeyToAccount(k as Hex).address;
    try {
      const bal = await publicClient.getBalance({ address });
      if (bal < LOW_GAS_WEI) out.push(`${label} wallet ${address} is low on gas: ${formatEther(bal)} ETH (top it up)`);
    } catch (e) {
      out.push(`${label} wallet balance unreadable: ${short(e)}`);
    }
  }
  return out;
}

async function notify(status: SweepStatus) {
  const problems = [...status.alerts, ...status.errors];
  const key = problems.join("\n");
  if (key === (sg.__sparecycleSweepNotified ?? "")) return; // unchanged since the last message
  sg.__sparecycleSweepNotified = key;
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url || !/^https:\/\//.test(url)) return;
  const text = problems.length
    ? `Sparecycle sweep bot (${config.network}): ${problems.length} problem(s)\n- ${problems.join("\n- ")}`
    : `Sparecycle sweep bot (${config.network}): all clear again`;
  try {
    // `content` is read by Discord, `text` by Slack; each ignores the other field.
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900), text }) });
  } catch (e) {
    console.error(`[sparecycle] alert webhook failed: ${short(e)}`);
  }
}

async function autorunTick() {
  let status: SweepStatus;
  try {
    const r = await runSweep({ send: true });
    const gas = await lowGasAlerts();
    status = { at: new Date().toISOString(), ok: !r.errors.length && !r.alerts.length && !gas.length, mode: r.mode, alerts: [...r.alerts, ...gas], errors: r.errors, txs: r.txs };
    if (r.txs.length || !status.ok) printReport({ ...r, alerts: status.alerts });
  } catch (e) {
    status = { at: new Date().toISOString(), ok: false, mode: "send", alerts: [], errors: [short(e)], txs: [] };
    console.error(`[sparecycle] sweep: ${short(e)}`);
  }
  sg.__sparecycleSweepLast = status;
  await notify(status);
}

/** Starts the always-on sweep (once per process). No-op unless SWEEP_AUTORUN_MINUTES >= 5. */
export function startSweepTimer() {
  const min = autorunMinutes();
  if (!min || sg.__sparecycleSweepTimer) return;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    autorunTick().finally(() => {
      running = false;
    });
  };
  sg.__sparecycleSweepTimer = setInterval(tick, min * 60_000);
  sg.__sparecycleSweepTimer.unref?.();
  setTimeout(tick, 30_000).unref?.(); // first run shortly after boot
  console.log(`[sparecycle] sweep bot on (every ${min} min${process.env.ALERT_WEBHOOK_URL ? ", alerts to webhook" : ""})`);
}
