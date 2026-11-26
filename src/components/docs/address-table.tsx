import { Hex } from "@/components/ui/address";
import { StatusTag } from "@/components/ui/status";
import { explorerAddressUrl, sourcifyUrl, type AddressRow, type SourceStatus } from "@/lib/addresses";

const BY_LABEL: Record<AddressRow["by"], string> = { sparecycle: "Sparecycle", pons: "Pons", safe: "Safe" };

function Source({ row, source }: { row: AddressRow; source?: SourceStatus }) {
  if (row.kind === "key") return <p className="text-xs text-faint">A wallet: no source code.</p>;
  if (row.by === "pons") return <p className="text-xs text-faint">Pons&apos;s code; not verified by Sparecycle.</p>;
  if (!source) return <p className="text-xs text-faint">Verification status not recorded.</p>;
  const { blockscout: b, sourcify: s } = source;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {s ? (
          <a href={sourcifyUrl(row.address)} target="_blank" rel="noreferrer" aria-label="Sourcify: exact match (open the source)">
            <StatusTag tone="live">Sourcify: exact match</StatusTag>
          </a>
        ) : null}
        {b ? (
          b.status === "verified" ? (
            <StatusTag tone="live">Blockscout: verified</StatusTag>
          ) : b.status === "not-verified" ? (
            <StatusTag tone="warn">Blockscout: shows unverified</StatusTag>
          ) : (
            <StatusTag tone="neutral">Blockscout: standard Safe proxy</StatusTag>
          )
        ) : null}
      </div>
      {b?.note ? <p className="text-xs leading-relaxed text-muted">{b.note}</p> : null}
      <p className="text-xs text-faint">
        {[s ? `Sourcify checked ${s.checkedOn}` : null, b ? `Blockscout checked ${b.checkedOn}` : null].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

/** Address rows: name and role, the full address (copy + explorer link), whose code it is and its source status. */
export function AddressTable({ rows, label }: { rows: AddressRow[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-line rounded-l border border-line">
      {rows.map((r) => (
        <li key={r.id} id={r.id} className="grid scroll-mt-24 gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)] sm:gap-6">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
              {r.name}
              <span className="rounded-s border border-line px-1.5 py-px text-[11px] font-normal text-faint">
                {r.kind === "key" ? "key" : `${BY_LABEL[r.by]} contract`}
              </span>
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{r.role}</p>
            <div className="mt-2">
              <Hex value={r.address} head={10} tail={8} href={explorerAddressUrl(r.address, r.network)} />
            </div>
          </div>
          <div className="min-w-0 sm:pt-0.5">
            <Source row={r} source={r.source} />
          </div>
        </li>
      ))}
    </ul>
  );
}
