import { issueNonce } from "@/server/auth";
import { handlePrivate, privateJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/auth/nonce — a single-use nonce (10 minutes) for an EIP-4361 sign-in message. */
export const GET = handlePrivate(async (req: Request) => privateJson(issueNonce(req)));
