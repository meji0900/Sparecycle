import Link from "next/link";

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
    title: "You don't hold the token",
    body: "You don't need it. Not to run a node, and not to pay for a job.",
    link: { href: "/token", label: "What the token is" },
  },
];

export function WhoFor() {
  return (
    <section id="who" aria-labelledby="who-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <h2 id="who-title" className="text-title font-semibold text-text">
          Who it is for
        </h2>
        <ul className="mt-10 grid gap-px overflow-hidden rounded-l border border-line bg-line md:grid-cols-3">
          {WHO.map((w) => (
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
