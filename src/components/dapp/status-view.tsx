"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { config, payoutAssetLabel } from "@/lib/config";
import { apiUrl, type ApiEpoch, type EpochsResponse, type JobsResponse, type StatusResponse } from "@/lib/dapp/api";
import { formatPayout, payoutUnit } from "@/lib/dapp/payout";
import { useNow } from "@/lib/dapp/use-api";
import { durationLabel } from "@/lib/dapp/duration";
import { formatInt, formatTime } from "@/lib/format";
import { useLiveJson, type ChainApi } from "@/lib/use-live";
import { PageHeader } from "./app-shell";
import { LiveCount, RootHash } from "./live-values";
import { RegisteredNodesTable } from "./node-list";
import { RecentJobs } from "./recent-jobs";
import { Countdown, FlapWord, OdometerNumber } from "./motion-bits";
import { Dash, Fact, Facts, Panel, SectionTitle, TableBox, TableMessage, td, th } from "./ui";

function Amount({ value, unit }: { value: string | bigint | null; unit: ReturnType<typeof payoutUnit> }) {
  const f = formatPayout(value, unit);
  return (
    <>
      <span className="num">{f.value}</span> <span className="text-sm text-muted">{f.unit}</span>
    </>
  );
}

function epochTag(e: Pick<ApiEpoch, "status">) {
  if (e.status === "posted") return <StatusTag tone="live">Root posted</StatusTag>;
  if (e.status === "closed-unposted") return <StatusTag tone="warn">Closed, not posted</StatusTag>;
  return <StatusTag tone="neutral">Open</StatusTag>;
}

export function StatusView() {
  const chain = useLiveJson<ChainApi>("/api/chain", 15_000);
  const status = useLiveJson<StatusResponse>(apiUrl("/status"), 15_000);
  const epochs = useLiveJson<EpochsResponse>(apiUrl("/epochs"), 30_000);
  const jobs = useLiveJson<JobsResponse>(apiUrl("/jobs?limit=20"), 15_000);
  const now = useNow(15_000);

  const unit = payoutUnit(chain.data);
  const rewards = chain.data?.rewards ?? null;
  const r = rewards && rewards.ok ? rewards.data : null;
  const net = chain.data?.network;
  const s = status.data;
  const schedulerDown = !!status.error && !s;
  const local = s?.epoch?.clock === "scheduler-local";

  // Current open epoch: the contract is the source of truth when configured; otherwise the scheduler's clock.
  const cur = r
    ? {
        id: r.currentEpoch,
        startedAt: r.epoch.startedAt,
        endsAt: r.epoch.startedAt + r.epochLength,
        length: r.epochLength,
        lengthSource: "contract" as const,
      }
    : s?.epoch
      ? {
          id: String(s.epoch.id),
          startedAt: s.epoch.startedAt,
          endsAt: s.epoch.endsAt,
          length: s.epoch.length,
          lengthSource: local ? ("scheduler-local" as const) : ("scheduler" as const),
        }
      : null;
  const remaining = cur && now !== null ? cur.endsAt - Math.floor(now / 1000) : null;

  const settledOnchain = r?.previous && r.previous.settled ? r.previous : null;
  const lastSettled = s?.lastSettled ?? null;
  const settledRows = (epochs.data?.epochs ?? []).filter((e) => e.status !== "open");
  const jobList = jobs.data?.jobs ?? [];
  const eligibleCount = jobList.filter((j) => j.eligible || j.paid).length;

  const contractWhy = !config.rewardContract ? "Reward contract not set" : rewards && !rewards.ok ? "Contract read failed" : chain.loading ? "Reading" : "Unavailable";

  return (
    <>
      <PageHeader
        art="/art/banner-status.webp"
        title="Network status"
        description="Live reads from the reward contract and the scheduler API. Anything not deployed or not reachable shows a dash, never a zero."
        aside={
          net?.ok ? (
            <StatusTag tone="live">
              Block <span className="num">{formatInt(BigInt(net.data.blockNumber))}</span>
            </StatusTag>
          ) : chain.loading ? (
            <StatusTag tone="neutral">Reading chain</StatusTag>
          ) : (
            <StatusTag tone="error">RPC unreachable</StatusTag>
          )
        }
      />

      <div className="space-y-3">
        {!config.rewardContract ? (
          <Notice tone="warn" title="Reward contract not set">
            Pot, reserved and claimed amounts are read from the reward contract, so they show dashes until it is deployed
            and configured. Scheduler data below is live.
          </Notice>
        ) : rewards && !rewards.ok ? (
          <Notice tone="error" title="Could not read the reward contract">
            The contract is configured but the read failed. Nothing is shown rather than a stale number.
          </Notice>
        ) : null}
        {r?.claimsPaused ? (
          <Notice tone="warn" title="Claims are paused">
            The contract owner paused claims. It cannot withdraw the pot; reserved amounts stay
            claimable after an unpause.
          </Notice>
        ) : null}
        {schedulerDown ? (
          <Notice
            tone="error"
            title="Scheduler API not reachable"
            action={
              <Button size="sm" variant="secondary" onClick={status.refresh}>
                Retry
              </Button>
            }
          >
            Epochs, jobs and nodes come from the scheduler. Nothing is listed rather than invented rows.
          </Notice>
        ) : null}
        {local ? (
          <Notice tone="neutral" title="Scheduler-local epoch clock">
            {s?.epoch?.note ? (
              <span className="block">
                Scheduler: <span className="text-text">{s.epoch.note}</span>.
              </span>
            ) : null}
            The reward contract is not configured, so the scheduler keeps its own epoch clock. It publishes trees, but nothing
            is posted on-chain and there is no pot to pay from.
          </Notice>
        ) : null}
      </div>

      {/* Epoch ledger */}
      <section aria-labelledby="ledger" className="mt-10">
        <SectionTitle
          id="ledger"
          title="Epoch ledger"
          description="Fees that arrive during an epoch go to its pot. At close the scheduler posts a root that reserves at most the pot; the rest rolls into the next epoch."
        />
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel
            title="Current epoch"
            aside={
              cur ? (
                r?.canClose ? (
                  <StatusTag tone="neutral">Ready to close</StatusTag>
                ) : (
                  <StatusTag tone="live">Open</StatusTag>
                )
              ) : null
            }
          >
            <Facts cols={2}>
              <Fact label="Epoch" note={cur?.lengthSource === "scheduler-local" ? "Scheduler-local clock" : cur ? (r ? "Read from the contract" : "From the scheduler") : undefined}>
                {cur ? <OdometerNumber value={Number(cur.id)} /> : <Dash why={status.loading || chain.loading ? "Reading" : "Unavailable"} />}
              </Fact>
              <Fact
                label="Settlement"
                note={cur ? (r?.canClose ? "End time reached; waiting for the scheduler to post the root." : "Root unposted until the epoch closes.") : undefined}
              >
                {cur ? <FlapWord text={r?.canClose ? "Closing" : "Open"} /> : <Dash />}
              </Fact>
              <Fact label="Started" note={!r && s?.epoch?.provisional ? "Provisional until the previous root is posted on-chain" : undefined}>
                {cur ? <span className="num">{formatTime(cur.startedAt)}</span> : <Dash />}
              </Fact>
              <Fact
                label="Ends"
                note={remaining === null || r ? undefined : remaining > 0 ? `Closes in ${durationLabel(remaining)}` : "End time passed; closes at the next scheduler run"}
              >
                {cur ? <span className="num">{formatTime(cur.endsAt)}</span> : <Dash />}
              </Fact>
              {r && cur ? (
                <Fact label="Time left" note="startedAt + epochLength, read from the contract.">
                  <Countdown endsAt={cur.endsAt} ended={<span className="text-muted">End reached</span>} />
                </Fact>
              ) : null}
              <Fact
                label="Epoch length"
                note={
                  cur?.lengthSource === "contract"
                    ? "epochLength() on the contract"
                    : config.epochLength === null
                      ? "[EPOCH_LENGTH] not set; the scheduler's local default"
                      : undefined
                }
              >
                {cur ? durationLabel(cur.length) : config.epochLength ? durationLabel(config.epochLength) : <Dash why="[EPOCH_LENGTH] not set" />}
              </Fact>
              <Fact label="Payout asset" note={r && r.payoutToken !== "0x0000000000000000000000000000000000000000" ? <Hex value={r.payoutToken} /> : undefined}>
                {r ? r.payout.symbol : <span className="num text-muted">{payoutAssetLabel()}</span>}
              </Fact>
              <Fact label="Pot so far">{r ? <Amount value={r.epoch.pot} unit={unit} /> : <Dash why={contractWhy} />}</Fact>
              <Fact label="Arrived, not yet credited" note="Credited to this pot by sync() or at close.">
                {r ? <Amount value={r.unaccounted} unit={unit} /> : <Dash why={contractWhy} />}
              </Fact>
              <Fact label="Reserved">
                <Dash why="Set when the epoch is settled" />
              </Fact>
              <Fact label="Claimed">
                <Dash why="Claims open after settlement" />
              </Fact>
              <Fact label="Merkle root">
                <span className="text-muted">Unposted</span>
              </Fact>
              <Fact label="Claims">
                {r ? r.claimsPaused ? <StatusTag tone="warn">Paused</StatusTag> : <span>Not paused</span> : <Dash why={contractWhy} />}
              </Fact>
            </Facts>
          </Panel>

          <Panel
            title="Latest settled epoch"
            aside={settledOnchain ? <StatusTag tone="live">Settled on-chain</StatusTag> : lastSettled ? epochTag({ status: lastSettled.status ?? "closed-unposted" }) : null}
          >
            {settledOnchain ? (
              <Facts cols={2}>
                <Fact label="Epoch">
                  <span className="num">{settledOnchain.index}</span>
                </Fact>
                <Fact label="Settled at">
                  <span className="num">{formatTime(settledOnchain.endedAt)}</span>
                </Fact>
                <Fact label="Pot at close">
                  <Amount value={settledOnchain.pot} unit={unit} />
                </Fact>
                <Fact label="Reserved in the root">
                  <Amount value={settledOnchain.reserved} unit={unit} />
                </Fact>
                <Fact label="Claimed">
                  <Amount value={settledOnchain.claimed} unit={unit} />
                </Fact>
                <Fact label="Still claimable" note="Reserved minus claimed.">
                  <Amount value={BigInt(settledOnchain.reserved) - BigInt(settledOnchain.claimed)} unit={unit} />
                </Fact>
                <Fact label={`Rolled into epoch ${BigInt(settledOnchain.index) + 1n}`} note="Pot minus reserved, moved at close.">
                  <Amount value={BigInt(settledOnchain.pot) - BigInt(settledOnchain.reserved)} unit={unit} />
                </Fact>
                <Fact label="Leaves" note="Wallets with a payout in this root.">
                  {lastSettled && String(lastSettled.id) === settledOnchain.index ? <span className="num">{formatInt(lastSettled.leaves)}</span> : <Dash why="From the scheduler" />}
                </Fact>
                <Fact label="Merkle root" className="sm:col-span-2">
                  {settledOnchain.merkleRoot === `0x${"00".repeat(32)}` ? (
                    <span className="text-muted">Empty root (nothing reserved)</span>
                  ) : (
                    <RootHash value={settledOnchain.merkleRoot} />
                  )}
                </Fact>
                {lastSettled?.postedTx && String(lastSettled.id) === settledOnchain.index ? (
                  <Fact label="Posted in" className="sm:col-span-2">
                    <Hex value={lastSettled.postedTx} kind="tx" />
                  </Fact>
                ) : null}
              </Facts>
            ) : lastSettled ? (
              <Facts cols={2}>
                <Fact label="Epoch" note="From the scheduler; not settled on-chain.">
                  <span className="num">{lastSettled.id}</span>
                </Fact>
                <Fact label="Leaves">
                  <span className="num">{formatInt(lastSettled.leaves)}</span>
                </Fact>
                <Fact label="Reserved in the tree">
                  <Amount value={lastSettled.reserved} unit={unit} />
                </Fact>
                <Fact label="Posted in">{lastSettled.postedTx ? <Hex value={lastSettled.postedTx} kind="tx" /> : <span className="text-muted">Not posted on-chain</span>}</Fact>
                <Fact label="Tree root" className="sm:col-span-2">
                  {lastSettled.root ? <RootHash value={lastSettled.root} /> : <span className="text-muted">Unposted</span>}
                </Fact>
              </Facts>
            ) : (
              <p className="px-5 py-6 text-sm text-muted">
                {status.loading && chain.loading ? (
                  "Reading…"
                ) : (
                  <>No epoch has been settled yet. The first root is posted when the current epoch closes.</>
                )}
              </p>
            )}
          </Panel>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Panel title="How the pot is split">
            <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-muted">
              <p>
                <span className="text-text">
                  Pro rata by work units across agreed jobs, floored, never above the pot; the rest rolls over.
                </span>
              </p>
              <p>
                Work units come from the job spec (image size and steps, or the token budget) and are computed by the
                scheduler, never reported by a node. The two nodes that agree on a job split its units equally. Disagreed and
                expired jobs are not paid. If the pot is empty, nobody is paid.
              </p>
            </div>
          </Panel>
          <Panel
            title="Scheduler"
            aside={s ? <StatusTag tone="live">Online</StatusTag> : schedulerDown ? <StatusTag tone="error">Not reachable</StatusTag> : <StatusTag tone="neutral">Reading</StatusTag>}
            footer="Centralized in this MVP: one operator closes epochs and posts roots."
          >
            <dl className="divide-y divide-line">
              <SchedRow label="Nodes online / registered">
                {s ? (
                  <>
                    <LiveCount value={s.nodes.online} /> <span className="text-faint">/</span> <LiveCount value={s.nodes.registered} />
                  </>
                ) : (
                  <Dash />
                )}
              </SchedRow>
              <SchedRow label="Jobs queued / running">
                {s ? (
                  <>
                    <LiveCount value={s.jobs.queued} /> <span className="text-faint">/</span> <LiveCount value={s.jobs.running} />
                  </>
                ) : (
                  <Dash />
                )}
              </SchedRow>
              <SchedRow label="Agreed / disagreed this epoch">
                {s ? (
                  <>
                    <LiveCount value={s.jobs.agreedThisEpoch} /> <span className="text-faint">/</span>{" "}
                    <LiveCount value={s.jobs.disagreedThisEpoch} />
                  </>
                ) : (
                  <Dash />
                )}
              </SchedRow>
              {s?.gpuPool?.configured ? (
                <SchedRow label="Project GPUs (on demand)">
                  {s.gpuPool.error ? (
                    <span className="text-amber">Error: {s.gpuPool.error}</span>
                  ) : s.gpuPool.state === "running" ? (
                    `On, off after ${s.gpuPool.idleMinutes ?? 10} min without jobs`
                  ) : s.gpuPool.state === "starting" ? (
                    "Starting (about 2 minutes)"
                  ) : s.gpuPool.state === "stopped" ? (
                    "Off, starts when a job waits"
                  ) : (
                    "Checking"
                  )}
                </SchedRow>
              ) : null}
              <SchedRow label="Root posting">
                {s ? s.rootPosting === "configured" ? "Configured" : <span className="text-amber">Not configured</span> : <Dash />}
              </SchedRow>
            </dl>
          </Panel>
        </div>
      </section>

      {/* Recent jobs */}
      <section aria-labelledby="jobs" className="mt-14">
        <SectionTitle
          id="jobs"
          title="Recent jobs"
          description="The latest 20 jobs and their check status. Prompts are never shown: each job carries a salted hash of its prompt. Only jobs two nodes agreed on are eligible for payment."
          aside={
            jobs.data && jobList.length ? (
              <span className="text-sm text-muted">
                <span className="num text-text">{eligibleCount}</span> eligible of <span className="num text-text">{jobList.length}</span> shown
              </span>
            ) : null
          }
        />
        {jobs.data ? (
          jobList.length ? (
            <RecentJobs jobs={jobList} now={now} />
          ) : (
            <p className="rounded-l border border-line px-5 py-6 text-sm text-muted">
              No jobs yet. <Link href="/jobs" className="link">Submit one</Link> with one of the two MVP models.
            </p>
          )
        ) : (
          <p className="rounded-l border border-line px-5 py-6 text-sm text-muted">
            {jobs.loading ? "Loading jobs…" : "Scheduler API not reachable. No rows are shown rather than invented ones."}
          </p>
        )}
      </section>

      {/* Nodes */}
      <section aria-labelledby="nodes" className="mt-14">
        <SectionTitle
          id="nodes"
          title="Registered nodes"
          description="Nodes that registered with the scheduler, by owner wallet. A node counts as online when it polled for work or sent a heartbeat in the last two minutes. A paused node says why (node client 0.4.0 and later) and takes no jobs until it resumes; when the pause began is not shown."
          aside={
            <Link href="/nodes" className="link text-sm">
              Run a node
            </Link>
          }
        />
        <RegisteredNodesTable />
      </section>

      {/* Settled epochs */}
      <section aria-labelledby="epochs" className="mt-14">
        <SectionTitle
          id="epochs"
          title="Closed epochs"
          description="Every epoch the scheduler has closed, with the root it published and the transaction that posted it on-chain."
          aside={
            <Link href="/app/claim" className="link text-sm">
              Claim
            </Link>
          }
        />
        <Panel>
          <TableBox label="Closed epochs" minWidth={860}>
            <thead>
              <tr>
                <th className={th}>Epoch</th>
                <th className={th}>Status</th>
                <th className={th}>Root</th>
                <th className={`${th} text-right`}>Reserved</th>
                <th className={`${th} text-right`}>Leaves</th>
                <th className={`${th} text-right`}>Agreed jobs</th>
                <th className={th}>Posted in</th>
              </tr>
            </thead>
            <tbody>
              {epochs.data ? (
                settledRows.length ? (
                  settledRows.map((e) => {
                    const f = formatPayout(e.reserved, unit);
                    return (
                      <tr key={e.id}>
                        <td className={`${td} num text-text`}>{e.id}</td>
                        <td className={td}>{epochTag(e)}</td>
                        <td className={td}>{e.root ? <Hex value={e.root} kind="hash" head={10} tail={6} link={false} /> : <Dash />}</td>
                        <td className={`${td} text-right whitespace-nowrap`}>
                          <span className="num text-text">{f.value}</span> <span className="text-xs text-muted">{f.unit}</span>
                        </td>
                        <td className={`${td} num text-right text-muted`}>{formatInt(e.leaves)}</td>
                        <td className={`${td} num text-right text-muted`}>{e.agreedJobs === undefined ? "—" : formatInt(e.agreedJobs)}</td>
                        <td className={td}>
                          {e.postedTx ? (
                            <Hex value={e.postedTx} kind="tx" />
                          ) : (
                            <span className="text-sm text-muted" title={e.postError ?? undefined}>
                              {e.clock === "scheduler-local" ? "Not posted (no contract)" : "Not posted yet"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <TableMessage colSpan={7}>No epoch has closed yet.</TableMessage>
                )
              ) : (
                <TableMessage colSpan={7}>{epochs.loading ? "Loading epochs…" : "Scheduler API not reachable. No rows are shown rather than invented ones."}</TableMessage>
              )}
            </tbody>
          </TableBox>
        </Panel>
      </section>
    </>
  );
}

function SchedRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm text-text">{children}</dd>
    </div>
  );
}
