import { DocsSidebar } from "@/components/docs/docs-sidebar";

/** Docs shell inside the site layout: navigation (src/lib/docs-nav.ts) beside a readable text column. */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-10 pb-24 sm:px-6 sm:pt-16">
      <div className="grid gap-8 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-14">
        <DocsSidebar />
        <article className="min-w-0 max-w-[780px]">{children}</article>
      </div>
    </div>
  );
}
