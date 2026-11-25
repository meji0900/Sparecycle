import { config } from "@/lib/config";

/** "Draft pending counsel" plus the review status, version and published URL when they exist, in plain words when not. */
export function ReviewStatus({ url, noun }: { url: string | null; urlPlaceholder?: string; noun: string }) {
  const review = process.env.LEGAL_REVIEW?.trim() || null;
  return (
    <div className="space-y-2">
      <p>
        <span className="inline-flex items-center gap-2 rounded-s border border-amber/30 bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber">
          <span aria-hidden className="size-0 border-x-[4px] border-b-[7px] border-x-transparent border-b-current" />
          Draft pending counsel
        </span>{" "}
        {review ? <>Review status: {review}.</> : <>Not reviewed by counsel yet.</>}
      </p>
      <p>
        Version {config.links.tosVersion ? <span className="num text-text">{config.links.tosVersion}</span> : "draft"}
        {" · "}
        Published {noun}:{" "}
        {url ? (
          <>
            <a href={url} className="link" target="_blank" rel="noreferrer">
              {url.replace(/^https?:\/\//, "")}
            </a>{" "}
            (that text wins over this page)
          </>
        ) : (
          <>none yet</>
        )}
      </p>
    </div>
  );
}
