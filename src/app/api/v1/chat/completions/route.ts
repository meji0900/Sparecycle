import { createChat, handleOpenAI } from "@/server/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/chat/completions (also /v1/…) — OpenAI-compatible, qwen2.5-1.5b only, `Authorization: Bearer sck_…`.
 * Answers 202 with an empty `choices` and `sparecycle.poll`; `Prefer: wait=<s>` may return the agreed answer (200).
 * `Idempotency-Key` makes a retried create return the first job. See src/server/openai.ts and /docs/api/openai.
 */
export const POST = handleOpenAI(async (req: Request) => createChat(req));
