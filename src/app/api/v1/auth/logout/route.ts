import { sessionCookie, signOut } from "@/server/auth";
import { handlePrivate, privateJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/auth/logout — ends the session and clears the cookie. */
export const POST = handlePrivate(async (req: Request) => {
  signOut(req);
  return privateJson({ ok: true }, 200, { "set-cookie": sessionCookie(req, "", 0) });
});
