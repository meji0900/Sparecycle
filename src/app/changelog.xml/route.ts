import { explorerTxUrl } from "@/lib/addresses";
import { CHANGELOG, KIND_LABEL, formatChangelogDate, rfc822Wita } from "@/lib/changelog";
import { siteOrigin } from "@/lib/site";

// Built from src/lib/changelog.ts at build time; the same entries as /changelog.
export const dynamic = "force-static";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GET /changelog.xml — RSS 2.0 feed of the changelog, newest first. */
export async function GET() {
  const origin = siteOrigin();
  const abs = (href: string) => (/^https?:\/\//.test(href) ? href : `${origin}${href}`);
  const items = CHANGELOG.map((e) => {
    const d = formatChangelogDate(e.date);
    const evidence = e.evidence.map((ev) => `<li><a href="${esc(abs(ev.tx ? explorerTxUrl(ev.tx) : ev.url!))}">${esc(ev.label)}</a></li>`).join("");
    const html = `<p>${esc(e.summary)}</p><p>Live: ${esc(d.wita)}${d.utc ? ` (${esc(d.utc)})` : ""}</p><p>Evidence:</p><ul>${evidence}</ul>`;
    return [
      "    <item>",
      `      <title>${esc(e.title)}</title>`,
      `      <link>${origin}/changelog#${e.id}</link>`,
      `      <guid isPermaLink="false">sparecycle-changelog-${e.id}</guid>`,
      `      <pubDate>${rfc822Wita(e.date)}</pubDate>`,
      `      <category>${esc(KIND_LABEL[e.kind])}</category>`,
      `      <description>${esc(html)}</description>`,
      "    </item>",
    ].join("\n");
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>Sparecycle changelog</title>",
    `    <link>${origin}/changelog</link>`,
    `    <atom:link href="${origin}/changelog.xml" rel="self" type="application/rss+xml" />`,
    "    <description>What is live on Sparecycle, each entry with its date and a link to its proof.</description>",
    "    <language>en</language>",
    `    <lastBuildDate>${rfc822Wita(CHANGELOG[0].date)}</lastBuildDate>`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=600" },
  });
}
