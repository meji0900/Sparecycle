import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

/** The X (formerly Twitter) mark. Used only to link to the project's own X account. */
export function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 fill-current", className)}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Icon button to the project's X account (NEXT_PUBLIC_X_URL). Renders nothing when the URL is not set. */
export function XLink({ className, withLabel = false }: { className?: string; withLabel?: boolean }) {
  const href = config.links.x;
  if (!href) return null;
  const handle = href.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "@").replace(/\/$/, "");
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Sparecycle on X (${handle})`}
      title={`Sparecycle on X (${handle})`}
      className={cn(
        "inline-flex items-center gap-2 text-muted transition-colors hover:text-text",
        !withLabel && "size-9 justify-center rounded-m border border-line hover:border-line-strong",
        className,
      )}
    >
      <XLogo />
      {withLabel ? <span>{handle}</span> : null}
    </a>
  );
}
