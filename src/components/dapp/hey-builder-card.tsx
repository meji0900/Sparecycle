import { StatusTag } from "@/components/ui/status";
import { config } from "@/lib/config";

/** The parts of HEY Research's Partner Card this page shows. Everything is optional: HEY's record may be thin. */
type PartnerCard = {
  verified_builder?: boolean;
  hey_status_label?: string;
  meaningful_ships_30d?: number | null;
  latest_meaningful_ship?: { summary?: string; occurred_at?: string | null; detected_at?: string | null } | null;
  latest_change?: { summary?: string; occurred_at?: string | null; detected_at?: string | null } | null;
  as_of?: string;
  project_link?: string;
  error?: string;
};

const HEY_API = "https://heyresearch.xyz/api/v1/builder";

/** HEY Research's public Partner Card for the official token, or null when HEY has not published the project. */
async function readPartnerCard(token: string): Promise<PartnerCard | null> {
  try {
    const r = await fetch(`${HEY_API}?chain=4663&token=${token}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 600 }, // ten minutes: HEY's own records change far slower
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const card = (await r.json()) as PartnerCard;
    return card.error ? null : card;
  } catch {
    return null;
  }
}

const ago = (iso: string | null | undefined) => {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return null;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

/**
 * An independent builder check from HEY Research (heyresearch.xyz), the public record of building on Robinhood
 * Chain. Renders nothing until HEY has published Sparecycle, so the page never shows an empty or invented badge.
 */
export async function HeyBuilderCard() {
  const token = config.tokenAddress;
  if (!token) return null;
  const card = await readPartnerCard(token.toLowerCase());
  if (!card) return null;
  const ship = card.latest_meaningful_ship ?? card.latest_change ?? null;
  const shipWhen = ago(ship?.occurred_at ?? ship?.detected_at);
  return (
    <section aria-labelledby="hey" className="mt-14">
      <div className="rounded-l border border-line bg-coal px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="hey" className="font-medium text-text">
            Independent check · HEY Research
          </h2>
          {card.verified_builder ? <StatusTag tone="live">Verified Builder</StatusTag> : <StatusTag tone="neutral">Listed</StatusTag>}
        </div>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Builder status</dt>
            <dd className="text-text">{card.hey_status_label ?? "Not measured yet"}</dd>
          </div>
          <div>
            <dt className="text-muted">Latest ship</dt>
            <dd className="text-text">{ship?.summary ? `${ship.summary}${shipWhen ? ` · ${shipWhen}` : ""}` : "None recorded yet"}</dd>
          </div>
          <div>
            <dt className="text-muted">Ships in 30 days</dt>
            <dd className="num text-text">{card.meaningful_ships_30d ?? "—"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Read from HEY&apos;s public Partner Card{card.as_of ? `, updated ${ago(card.as_of)}` : ""}. HEY records building activity from
          public sources; it is not a rating, an endorsement or investment advice.{" "}
          {card.project_link ? (
            <a href={card.project_link} target="_blank" rel="noreferrer" className="link">
              View on HEY
            </a>
          ) : null}
        </p>
      </div>
    </section>
  );
}
