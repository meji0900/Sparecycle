// Next.js proxy, limited to the holder page (docs/token-features.md). While TOKEN_HOLDER_PAGE is not "on" (the default),
// /token/holders is rewritten to a path no route matches, so it answers exactly the 404 page of any unknown URL. (A
// notFound() in the page itself streams Next's error shell with the page's own title instead, which is not the same.)
// The page also calls notFound() when the flag is off, as a second guard. No other path reaches this proxy.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if ((process.env.TOKEN_HOLDER_PAGE ?? "").trim().toLowerCase() === "on") return NextResponse.next();
  return NextResponse.rewrite(new URL("/_sparecycle-not-found", request.url));
}

export const config = { matcher: ["/token/holders"] };
