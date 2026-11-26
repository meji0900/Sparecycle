// Public URLs of the project: the site origin used in copy-paste commands and feeds, and the public source repo.
import { config } from "./config";

/** The live site, used when no origin is configured (local builds still print commands for the real site). */
export const LIVE_SITE = "https://sparecycle.tech";
/** The public source repository (MIT). */
export const REPO_URL = "https://github.com/meji0900/Sparecycle";

/** Site origin without a trailing slash: NEXT_PUBLIC_APP_URL, else https://NEXT_PUBLIC_DOMAIN, else the live site. */
export function siteOrigin(): string {
  const app = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (app && /^https?:\/\//.test(app)) return app.replace(/\/+$/, "");
  if (config.domain) return `https://${config.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return LIVE_SITE;
}

/** A file in the public repo, e.g. repoFile("docs/private-outputs.md"). */
export const repoFile = (path: string) => `${REPO_URL}/blob/main/${path}`;
