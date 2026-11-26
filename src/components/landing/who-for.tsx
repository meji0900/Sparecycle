import Link from "next/link";
import { TOKEN_COPY_OFF, tokenCopy, type TokenCopy } from "@/lib/token-copy";

const WHO = [
  {
    title: "You have a spare GPU",
    body: "And you want to be paid for real work, not for holding a token.",
    link: { href: "/nodes", label: "Run a node" },
  },
  {
    title: "You want an AI job done",
    body: "And proof that two machines agreed on the result before you pay for it.",
    link: { href: "/playground", label: "Run a job" },
  },
  {
    ...tokenCopy(TOKEN_COPY_OFF).whoForNoToken,
    link: { href: "/token", label: "What the token is" },
  },
];

/** `noToken`: the flag-dependent third card (src/lib/token-copy.ts); the default is today's card. */
export function WhoFor({ noToken }: { noToken?: TokenCopy["whoForNoToken"] } = {}) {
  const who = noToken ? WHO.map((w, i) => (i === WHO.length - 1 ? { ...w, ...noToken } : w)) : WHO;
  return (
    <section id="who" aria-labelledby="who-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <h2 id="who-title" className="text-title font-semibold text-text">
          Who it is for
        </h2>
        <ul className="mt-10 grid gap-px overflow-hidden rounded-l border border-line bg-line md:grid-cols-3">
          {who.map((w) => (
            <li key={w.title} className="flex flex-col gap-2 bg-coal p-6">
              <p className="text-lg font-medium text-text">{w.title}</p>
              <p className="text-muted">{w.body}</p>
              <Link href={w.link.href} className="link mt-auto pt-3 text-sm">
                {w.link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
