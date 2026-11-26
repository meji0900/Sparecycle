// The read model of the holder page /token/holders (brief §7, docs/token-features.md), behind TOKEN_HOLDER_PAGE (default
// off). ONLY on-chain data: every figure carries the transaction, event log or contract read it comes from, and a part
// whose contract is not deployed is NOT_LIVE_YET, never a zero or a sample number. src/server/holder-page.test.ts fails
// if a figure or a row has no source. The page (src/app/(dapp)/token/holders/page.tsx) renders this model only; it
// formats no number of its own.
//
// Reads go through ./chain-io (tokenChain) and are cached per epoch, with the time and block of the read on the page.
// The burn rows are on-chain events only (./burns readBurnRows); the "carried over" rows are the scheduler's burn plans
// (amount and reason), each linked to the charge transaction its share was read from.
import type { Address, Hex } from "viem";
import {
  ADDR,
  explorerAddressUrl,
  explorerTxUrl,
  HOLDER_CONTRACT_ALLOWLIST,
  HOLDER_EXCLUSIONS,
  MAINNET_EXPLORER,
  NOT_LIVE_YET,
  SPARE_START_BLOCK,
  TOKEN_CONTRACTS,
} from "@/lib/addresses";
import { formatAmount, formatTime } from "@/lib/format";
import { HOLDER_MIN_SPARE_WEI, HOLDER_MODE, UNCLAIMED_ROLLOVER_EPOCHS } from "@/lib/token-rules";
import { NotLiveError, tokenChain } from "./chain-io";
import { carryRows, readBurnRows, type BurnRow, type CarryRow, type SlashBurnRow } from "./burns";
import { getDb } from "./db";
import { serverEnv } from "./env";
import { openEpochRow } from "./epochs";
import { HOLDER_WEIGHT_METHOD } from "./holders";

export type Source = { label: string; href: string };
export type Figure =
  | { kind: "value"; label: string; value: string; unit?: string; source: Source; note?: string }
  | { kind: "not-live"; label: string; why: string };
export type Row = { source: Source; cells: string[] };
export type Table = { label: string; columns: string[]; rows: Row[]; empty: string };
export type Section = { id: string; title: string; description: string; live: boolean; figures: Figure[]; tables: Table[] };
export type ExclusionItem = { label: string; why: string } & ({ address: Address; href: string } | { address: null; notLive: string });
/**
 * The claim panel (TOKEN_HOLDERS on): what the page states about eligibility, already formatted, and the contracts the
 * browser claims from. null while TOKEN_HOLDERS is off (the page then renders exactly as before).
 */
export type HolderClaimsModel = {
  /** True when SparecycleHolderPool and SparecycleJobPaymentsV2 are both set: roots are posted and claims are possible. */
  live: boolean;
  pool: Address | null;
  jobPaymentsV2: Address | null;
  minimumText: string;
  method: string;
  lastComputedText: string | null;
  rolloverEpochs: number;
  rolloverText: string;
};
export type HolderPageModel = {
  readAt: number;
  readAtText: string;
  block: { number: string; href: string } | null;
  readError: string | null;
  sections: Section[];
  exclusions: ExclusionItem[];
  contractRule: string;
  modeRule: string[];
  claims: HolderClaimsModel | null;
};

const readLink = (address: Address, what: string): Source => ({ label: `${what} (contract read)`, href: `${explorerAddressUrl(address)}?tab=read_contract` });
const txLink = (hash: string, label = "Transaction"): Source => ({ label, href: explorerTxUrl(hash) });
const notLive = (label: string, why: string): Figure => ({ kind: "not-live", label, why });
const eth = (wei: bigint) => formatAmount(wei, 18, 6);
const spare = (wei: bigint) => formatAmount(wei, 18, 2);

/** Everything the page shows, already read. Built by loadHolderPage; tests build it by hand. */
export type HolderPageReads = {
  readAt: number;
  block: bigint | null;
  readError: string | null;
  contracts: { nodeStake: Address | null; holderPool: Address | null; burner: Address | null; jobPaymentsV2: Address | null };
  spareToken: Address;
  payments: Address;
  treasuryBps: number | null;
  burns:
    | { status: "live"; fromBlock: bigint; rows: BurnRow[]; slashes: SlashBurnRow[]; burner: "live" | "not-live"; stakeLive: boolean }
    | { status: "not-live" | "error"; why: string };
  carry: CarryRow[];
  staked:
    | { status: "live"; total: bigint; owners: { owner: Address; staked: bigint; projectRun: boolean }[]; proposals: { proposalId: bigint; owner: Address; amount: bigint; evidenceHash: Hex; txHash: Hex; executedTx: Hex | null; evidenceUrl: string | null }[] | null }
    | { status: "not-live" | "error"; why: string };
  distributed:
    | { status: "live"; roots: { epochId: bigint; totalEth: bigint; txHash: Hex }[]; claims: { epochId: bigint; mode: number; amount: bigint; txHash: Hex }[] }
    | { status: "not-live" | "error"; why: string };
  /** TOKEN_HOLDERS on: the scheduler's holder-root state (absent or null = off). */
  holders?: { lastComputedAt: number | null } | null;
};

/** Pure: the page model from reads. */
export function buildHolderPage(r: HolderPageReads): HolderPageModel {
  const sections: Section[] = [];

  // ---- Burned ------------------------------------------------------------------------------------------------
  const burnFigures: Figure[] = [];
  const burnTables: Table[] = [];
  if (r.burns.status === "live") {
    const a = r.burns.rows.filter((x) => x.path === "2a");
    const b = r.burns.rows.filter((x) => x.path === "2b");
    const sum = (rows: { spareBurned: bigint }[]) => rows.reduce((s, x) => s + x.spareBurned, 0n);
    const scanned = `SPARE Transfer logs to the zero / dead address from block ${r.burns.fromBlock}`;
    burnFigures.push(
      a.length
        ? { kind: "value", label: "Burned through the treasury Safe (phase 2a)", value: spare(sum(a)), unit: "SPARE", source: { label: scanned, href: explorerAddressUrl(r.spareToken) }, note: `${a.length} transaction${a.length === 1 ? "" : "s"}, each listed below.` }
        : { kind: "value", label: "Burned through the treasury Safe (phase 2a)", value: "No burn transaction yet", source: { label: scanned, href: explorerAddressUrl(r.spareToken) } },
    );
    burnFigures.push(
      r.burns.burner === "live" && r.contracts.burner
        ? b.length
          ? { kind: "value", label: "Burned by SparecycleBurner (phase 2b)", value: spare(sum(b)), unit: "SPARE", source: { label: "Burned events", href: explorerAddressUrl(r.contracts.burner) } }
          : { kind: "value", label: "Burned by SparecycleBurner (phase 2b)", value: "No Burned event yet", source: { label: "Burned events", href: explorerAddressUrl(r.contracts.burner) } }
        : notLive("Burned by SparecycleBurner (phase 2b)", "SparecycleBurner is not deployed. It needs SparecycleJobPaymentsV2 and an audit first."),
    );
    burnFigures.push(
      r.burns.stakeLive && r.contracts.nodeStake
        ? r.burns.slashes.length
          ? { kind: "value", label: "Burned by executed slashes (shown apart)", value: spare(sum(r.burns.slashes)), unit: "SPARE", source: { label: "SPARE leaving SparecycleNodeStake to a burn address", href: explorerAddressUrl(r.contracts.nodeStake) } }
          : { kind: "value", label: "Burned by executed slashes (shown apart)", value: "No executed slash yet", source: { label: "SPARE leaving SparecycleNodeStake to a burn address", href: explorerAddressUrl(r.contracts.nodeStake) } }
        : notLive("Burned by executed slashes (shown apart)", "SparecycleNodeStake is not deployed."),
    );
    burnTables.push({
      label: "Burn transactions",
      columns: ["Epoch", "ETH in", "SPARE burned", "Path", "When"],
      rows: r.burns.rows.map((x) => ({
        source: txLink(x.txHash),
        cells: [x.epochId === null ? "not matched to a plan" : String(x.epochId), x.ethIn === null ? "no swap in this transaction" : `${eth(x.ethIn)} ETH`, `${spare(x.spareBurned)} SPARE`, x.path, formatTime(x.time)],
      })),
      empty: "No burn transaction yet.",
    });
  } else {
    burnFigures.push(
      notLive("Burned through the treasury Safe (phase 2a)", r.burns.why),
      notLive("Burned by SparecycleBurner (phase 2b)", "SparecycleBurner is not deployed. It needs SparecycleJobPaymentsV2 and an audit first."),
      notLive("Burned by executed slashes (shown apart)", "SparecycleNodeStake is not deployed."),
    );
  }
  if (r.carry.length) {
    burnTables.push({
      label: "Carried over",
      columns: ["Epoch", "ETH carried to the next epoch", "Why"],
      rows: r.carry.map((c) => ({
        source: c.chargeTx ? txLink(c.chargeTx, "Charge transaction (the share is read from its Charged event)") : { label: "Job payments contract", href: explorerAddressUrl(r.payments) },
        cells: [String(c.epochId), `${eth(c.carriedWei)} ETH`, c.reason],
      })),
      empty: "Nothing carried over.",
    });
  }
  sections.push({
    id: "burned",
    title: "Burned",
    description:
      "Each epoch, part of the treasury share is used to buy SPARE and burn it, and every transaction is listed. Only burn events read from the chain count here. An epoch whose amount could not be bought (cap on a thin pool) shows a carried-over row with the amount.",
    live: r.burns.status === "live",
    figures: burnFigures,
    tables: burnTables,
  });

  // ---- Distributed to holders ------------------------------------------------------------------------------------
  const dist = r.distributed;
  const distFigures: Figure[] = [];
  const distTables: Table[] = [];
  if (dist.status === "live" && r.contracts.holderPool) {
    const pool = r.contracts.holderPool;
    const credits = dist.claims.filter((c) => c.mode === HOLDER_MODE.credits);
    distFigures.push(
      { kind: "value", label: "Epoch roots posted", value: String(dist.roots.length), source: { label: "RootPosted events", href: explorerAddressUrl(pool) } },
      credits.length
        ? { kind: "value", label: "Claimed as compute credits", value: eth(credits.reduce((s, c) => s + c.amount, 0n)), unit: "ETH of credits", source: { label: "Claimed events", href: explorerAddressUrl(pool) } }
        : { kind: "value", label: "Claimed as compute credits", value: "No claim yet", source: { label: "Claimed events", href: explorerAddressUrl(pool) } },
    );
    distTables.push({
      label: "Roots",
      columns: ["Epoch", "Holder share posted"],
      rows: dist.roots.map((x) => ({ source: txLink(x.txHash), cells: [String(x.epochId), `${eth(x.totalEth)} ETH`] })),
      empty: "No root posted yet.",
    });
    distTables.push({
      label: "Claims",
      columns: ["Epoch", "Mode", "Amount"],
      rows: dist.claims.map((x) => ({ source: txLink(x.txHash), cells: [String(x.epochId), x.mode === HOLDER_MODE.credits ? "compute credits" : `mode ${x.mode}`, `${eth(x.amount)} ETH`] })),
      empty: "No claim yet.",
    });
  } else {
    const why = dist.status === "live" ? "SparecycleHolderPool is not deployed." : dist.why;
    distFigures.push(notLive("Epoch roots posted", why), notLive("Claimed as compute credits", why));
  }
  sections.push({
    id: "distributed",
    title: "Distributed to holders",
    description:
      "Eligible holders can claim compute credits: credits pay for jobs and cannot be withdrawn as ETH. Each epoch's holder share is posted as a Merkle root; every root and claim is listed with its transaction.",
    live: dist.status === "live",
    figures: distFigures,
    tables: distTables,
  });

  // ---- Staked ----------------------------------------------------------------------------------------------------
  const st = r.staked;
  const stFigures: Figure[] = [];
  const stTables: Table[] = [];
  if (st.status === "live" && r.contracts.nodeStake) {
    const stake = r.contracts.nodeStake;
    const project = st.owners.filter((o) => o.projectRun);
    const community = st.owners.filter((o) => !o.projectRun);
    stFigures.push(
      { kind: "value", label: "SPARE in SparecycleNodeStake", value: spare(st.total), unit: "SPARE", source: { label: "SPARE balanceOf(SparecycleNodeStake) (contract read)", href: `${explorerAddressUrl(r.spareToken)}?tab=read_contract` } },
      { kind: "value", label: "Node owners with a stake: project-run", value: String(project.length), source: readLink(stake, "stakedOf(owner) of each registered node owner") },
      { kind: "value", label: "Node owners with a stake: community", value: String(community.length), source: readLink(stake, "stakedOf(owner) of each registered node owner") },
    );
    if (st.proposals) {
      stTables.push({
        label: "Slash proposals",
        columns: ["Proposal", "Owner", "Amount", "State"],
        rows: st.proposals.map((p) => ({
          source: p.evidenceUrl ? { label: "Evidence", href: p.evidenceUrl } : txLink(p.txHash, "Proposal transaction"),
          cells: [String(p.proposalId), p.owner, `${spare(p.amount)} SPARE`, p.executedTx ? "executed" : "open"],
        })),
        empty: "No slash proposal on-chain.",
      });
    }
  } else {
    const why = st.status === "live" ? "SparecycleNodeStake is not deployed." : st.why;
    stFigures.push(
      notLive("SPARE in SparecycleNodeStake", why),
      notLive("Node owners with a stake: project-run", why),
      notLive("Node owners with a stake: community", why),
      notLive("Slash proposals (open and executed)", why),
    );
  }
  sections.push({
    id: "staked",
    title: "Staked by node owners",
    description:
      "Node owners would lock SPARE to receive jobs. Repeated proven wrong results cost part of the stake, which is burned. The scheduler and the treasury Safe judge each case, so this is not trustless; every proposal comes with public evidence.",
    live: st.status === "live",
    figures: stFigures,
    tables: stTables,
  });

  // ---- Rules -----------------------------------------------------------------------------------------------------
  const ruleFigures: Figure[] = [
    r.treasuryBps === null
      ? notLive("Treasury cut of every charge", "Could not read SparecycleJobPayments right now.")
      : { kind: "value", label: "Treasury cut of every charge", value: `${r.treasuryBps / 100}%`, source: readLink(r.payments, "SparecycleJobPayments TREASURY_BPS"), note: "The node pot keeps the rest. Fixed in the live contract." },
    notLive("Split of the treasury cut (burn / holders / treasury)", "Read from SparecycleJobPaymentsV2 once it is deployed and audited."),
    notLive("Minimum stake per node", "Read from SparecycleNodeStake (minStakePerNode) once it is deployed."),
    r.holders
      ? {
          kind: "value",
          label: "Holder minimum (time-weighted SPARE)",
          value: spare(HOLDER_MIN_SPARE_WEI),
          unit: "SPARE",
          source: { label: "Scheduler rule N11, published with every root (GET /api/v1/holders/epochs)", href: "/api/v1/holders/epochs" },
          note: "Set by the scheduler, not by a contract: an address whose six-hour average is below it gets no share.",
        }
      : notLive("Holder minimum (time-weighted SPARE)", "Read from SparecycleHolderPool once it is deployed."),
  ];
  sections.push({
    id: "rules",
    title: "Rules",
    description: "Values come from contract reads, not from settings. A rule whose contract is not deployed shows a placeholder.",
    live: r.treasuryBps !== null,
    figures: ruleFigures,
    tables: [],
  });

  return {
    readAt: r.readAt,
    readAtText: formatTime(Math.floor(r.readAt / 1000)),
    block: r.block === null ? null : { number: r.block.toString(), href: `${MAINNET_EXPLORER}/block/${r.block}` },
    readError: r.readError,
    sections,
    exclusions: HOLDER_EXCLUSIONS.map((e) =>
      e.address ? { label: e.label, why: e.why, address: e.address, href: explorerAddressUrl(e.address) } : { label: e.label, why: e.why, address: null, notLive: NOT_LIVE_YET },
    ),
    contractRule:
      HOLDER_CONTRACT_ALLOWLIST.length === 0
        ? "Any other address with contract code is excluded too; no contract is allow-listed. A wallet with an EIP-7702 delegation counts as a wallet."
        : `Any other address with contract code is excluded too, except ${HOLDER_CONTRACT_ALLOWLIST.length} allow-listed contract(s).`,
    modeRule: [
      "A holder chooses how to receive their share with setMode on SparecycleHolderPool. A choice made during an epoch counts from the next epoch.",
      "Holders who never chose receive compute credits. Compute credits is the only mode; a tokenized-stock mode is not offered.",
      "Weights are time-weighted over each six-hour epoch from SPARE transfer logs, so SPARE held for a few seconds counts for a few seconds. Staked SPARE counts for its owner.",
    ],
    claims: r.holders
      ? {
          live: r.contracts.holderPool !== null && r.contracts.jobPaymentsV2 !== null,
          pool: r.contracts.holderPool,
          jobPaymentsV2: r.contracts.jobPaymentsV2,
          minimumText: `${spare(HOLDER_MIN_SPARE_WEI)} SPARE`,
          method: HOLDER_WEIGHT_METHOD,
          lastComputedText: r.holders.lastComputedAt === null ? null : formatTime(r.holders.lastComputedAt),
          rolloverEpochs: UNCLAIMED_ROLLOVER_EPOCHS,
          rolloverText: `${UNCLAIMED_ROLLOVER_EPOCHS} epochs (${(UNCLAIMED_ROLLOVER_EPOCHS * 6) / 24} days)`,
        }
      : null,
  };
}

// ---- Loading (chain reads, cached per epoch) ----------------------------------------------------------------------

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e));

async function readStaked(start: bigint | null): Promise<HolderPageReads["staked"]> {
  const stake = TOKEN_CONTRACTS.nodeStake;
  if (!stake) return { status: "not-live", why: "SparecycleNodeStake is not deployed. It needs an audit, the Safe key split and community nodes first." };
  try {
    const total = await tokenChain.spareBalanceOf(stake);
    const owners = getDb().prepare("SELECT DISTINCT owner FROM nodes").all() as { owner: Address }[];
    const project = serverEnv.projectOwners();
    const list: { owner: Address; staked: bigint; projectRun: boolean }[] = [];
    for (const o of owners) {
      const s = await tokenChain.stakedOf(o.owner);
      if (s > 0n) list.push({ owner: o.owner, staked: s, projectRun: project.has(o.owner.toLowerCase()) });
    }
    let proposals = null;
    if (start !== null) {
      const [proposed, slashed] = await Promise.all([tokenChain.slashProposedEvents(start), tokenChain.slashedEvents(start)]);
      const local = getDb().prepare("SELECT id, evidence_hash FROM token_slash_proposals").all() as { id: number; evidence_hash: string }[];
      proposals = proposed.map((p) => ({
        proposalId: p.proposalId,
        owner: p.owner,
        amount: p.amount,
        evidenceHash: p.evidenceHash,
        txHash: p.txHash,
        executedTx: slashed.find((s) => s.proposalId === p.proposalId)?.txHash ?? null,
        evidenceUrl: (() => {
          const l = local.find((x) => x.evidence_hash.toLowerCase() === p.evidenceHash.toLowerCase());
          return l ? `/api/v1/slashing/${l.id}` : null;
        })(),
      }));
    }
    return { status: "live", total, owners: list, proposals };
  } catch (e) {
    return { status: "error", why: e instanceof NotLiveError ? e.message : `Could not read SparecycleNodeStake right now (${errText(e)}).` };
  }
}

async function readDistributed(start: bigint | null): Promise<HolderPageReads["distributed"]> {
  if (!TOKEN_CONTRACTS.holderPool) return { status: "not-live", why: "SparecycleHolderPool is not deployed. It needs SparecycleJobPaymentsV2, a legal review and an audit first." };
  if (start === null) return { status: "not-live", why: "The first block to read events from is not recorded yet." };
  try {
    const ev = await tokenChain.holderPoolEvents(start);
    return {
      status: "live",
      roots: ev.roots.map((x) => ({ epochId: x.epochId, totalEth: x.totalEth, txHash: x.txHash })),
      claims: ev.claims.map((x) => ({ epochId: x.epochId, mode: x.mode, amount: x.amount, txHash: x.txHash })),
    };
  } catch (e) {
    return { status: "error", why: `Could not read SparecycleHolderPool right now (${errText(e)}).` };
  }
}

async function readBurns(start: bigint | null): Promise<HolderPageReads["burns"]> {
  if (start === null) return { status: "not-live", why: "Burns are not live. The first SPARE block to read burn transfers from is not recorded yet." };
  try {
    return { status: "live", fromBlock: start, ...(await readBurnRows(start)) };
  } catch (e) {
    return { status: "error", why: `Could not read the burn transfers right now (${errText(e)}).` };
  }
}

/** Reads everything the page shows (no cache). */
export async function readHolderPage(): Promise<HolderPageReads> {
  const start = SPARE_START_BLOCK;
  const [block, treasuryBps, burns, staked, distributed] = await Promise.all([
    tokenChain.headBlock().catch(() => null),
    tokenChain.treasuryBps().catch(() => null),
    readBurns(start),
    readStaked(start),
    readDistributed(start),
  ]);
  return {
    readAt: Date.now(),
    block,
    readError: block === null ? "The chain could not be reached; the parts that need a read show why." : null,
    contracts: { ...TOKEN_CONTRACTS },
    spareToken: ADDR.spareToken,
    payments: ADDR.payments,
    treasuryBps,
    burns,
    carry: carryRows(),
    staked,
    distributed,
    holders: serverEnv.tokenHolders()
      ? { lastComputedAt: (getDb().prepare("SELECT MAX(created_at) AS t FROM token_holder_roots").get() as { t: number | null }).t }
      : null,
  };
}

const g = globalThis as typeof globalThis & { __sparecycleHolderPage?: { key: number; model: HolderPageModel } };

/** The page model, cached per epoch (reads that failed are not cached). */
export async function loadHolderPage(): Promise<HolderPageModel> {
  const key = openEpochRow()?.id ?? Math.floor(Date.now() / 1000 / 21_600);
  const hit = g.__sparecycleHolderPage;
  if (hit && hit.key === key) return hit.model;
  const reads = await readHolderPage();
  const model = buildHolderPage(reads);
  const failed = reads.block === null || reads.treasuryBps === null || [reads.burns, reads.staked, reads.distributed].some((x) => x.status === "error");
  if (!failed) g.__sparecycleHolderPage = { key, model };
  return model;
}

