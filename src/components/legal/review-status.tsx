import { config } from "@/lib/config";
import { Placeholder } from "./legal-page";

/** "Draft pending counsel ([LEGAL_REVIEW])" plus the version and the published URL when they exist. */
export function ReviewStatus({ url, urlPlaceholder, noun }: { url: string | null; urlPlaceholder: string; noun: string }) {
  const review = process.env.LEGAL_REVIEW?.trim() || null;
  return (
    <div className="space-y-2">
      <p>
        <span className="inline-flex items-center gap-2 rounded-s border border-amber/30 bg-amber-soft px-2 py-0.5 text-xs font-medium text-amber">
          <span aria-hidden className="size-0 border-x-[4px] border-b-[7px] border-x-transparent border-b-current" />
          Draft pending counsel
        </span>{" "}
        {review ? <>Review status: {review}.</> : <Placeholder>[LEGAL_REVIEW]</Placeholder>}
      </p>
      <p>
        Version {config.links.tosVersion ? <span className="num text-text">{config.links.tosVersion}</span> : <Placeholder>[TOS_VERSION]</Placeholder>}
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
          <>
            <Placeholder>{urlPlaceholder}</Placeholder> (not set yet)
          </>
        )}
      </p>
    </div>
  );
}
