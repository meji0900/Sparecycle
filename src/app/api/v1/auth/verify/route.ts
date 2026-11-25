import { POLICY } from "@/server/env";
import { sessionCookie, signIn } from "@/server/auth";
import { ApiError, handlePrivate, parseJson, privateJson, readBody } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/auth/verify { message, signature } — checks a signed EIP-4361 message and sets the session cookie
 * `sc_session` (HttpOnly, SameSite=Strict, Secure, 12 h). Answers { ok, address, expiresAt }.
 */
export const POST = handlePrivate(async (req: Request) => {
  // JSON only: a cross-site HTML form can't send it, so another site can't plant its own session here.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new ApiError(415, "json-required", "send the sign-in as application/json");
  }
  const body = parseJson(await readBody(req, 8 * 1024));
  const s = await signIn(req, body);
  return privateJson({ ok: true, address: s.address, expiresAt: s.expiresAt }, 200, {
    "set-cookie": sessionCookie(req, s.sessionId, POLICY.sessionSeconds),
  });
});
