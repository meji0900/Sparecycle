"use client";

import Link from "next/link";
import { Hex } from "@/components/ui/address";
import { StatusTag } from "@/components/ui/status";
import { apiUrl, type NodesResponse } from "@/lib/dapp/api";
import { useNow } from "@/lib/dapp/use-api";
import { formatInt } from "@/lib/format";
import { useLiveJson } from "@/lib/use-live";
import { IdleGuardNote, NodeStatePill } from "./node-state";
import { Panel, TableBox, TableMessage, td, th } from "./ui";

const CAP_LABEL: Record<string, string> = { "image:sd15": "SD 1.5", "text:qwen2.5-1.5b": "Qwen2.5-1.5B" };

/** Every registered node from GET /api/v1/nodes, with its Idle Guard state. Used on /app and /nodes. */
export function RegisteredNodesTable() {
  const nodes = useLiveJson<NodesResponse>(apiUrl("/nodes"), 30_000);
  const now = useNow(15_000);
  const nodeList = nodes.data?.nodes ?? [];
  return (
    <Panel>
      <TableBox label="Registered nodes" minWidth={860}>
        <thead>
          <tr>
            <th className={th}>Owner</th>
            <th className={th}>GPU</th>
            <th className={th}>VRAM</th>
            <th className={th}>Models</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Agreed jobs</th>
            <th className={`${th} text-right`}>This epoch</th>
          </tr>
        </thead>
        <tbody>
          {nodes.data ? (
            nodeList.length ? (
              nodeList.map((n) => (
                <tr key={n.nodeKey}>
                  <td className={td}>
                    <Hex value={n.owner} />
                  </td>
                  <td className={`${td} text-text`}>
                    {n.gpu}
                    {n.backend && n.backend !== "cuda" ? (
                      <span className="num ml-2 rounded-s border border-line px-1.5 py-0.5 text-[11px] text-muted">{n.backend}</span>
                    ) : null}
                    {n.dev ? (
                      <StatusTag tone="off" className="ml-2">
                        Test runner, unpaid
                      </StatusTag>
                    ) : null}
                    {n.project ? (
                      <StatusTag tone="neutral" className="ml-2">
                        {n.paidTest ? "Run by Sparecycle, paid test node" : "Run by Sparecycle, unpaid"}
                      </StatusTag>
                    ) : null}
                  </td>
                  <td className={`${td} num whitespace-nowrap text-muted`}>{(n.vramMb / 1024).toFixed(1)} GB</td>
                  <td className={`${td} whitespace-nowrap text-muted`}>{n.caps.map((c) => CAP_LABEL[c] ?? c).join(", ") || "—"}</td>
                  <td className={td}>
                    <NodeStatePill node={n} now={now} />
                    <IdleGuardNote backend={n.backend} className="mt-1.5" />
                  </td>
                  <td className={`${td} num text-right text-text`}>{formatInt(n.agreedJobs)}</td>
                  <td className={`${td} num text-right text-muted`}>{formatInt(n.epochAgreedJobs)}</td>
                </tr>
              ))
            ) : (
              <TableMessage colSpan={7}>
                No nodes registered yet. The <Link href="/nodes" className="link">install guide</Link> shows how to add one.
              </TableMessage>
            )
          ) : (
            <TableMessage colSpan={7}>{nodes.loading ? "Loading nodes…" : "Scheduler API not reachable. No rows are shown rather than invented ones."}</TableMessage>
          )}
        </tbody>
      </TableBox>
    </Panel>
  );
}
