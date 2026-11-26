import { createImage, handleOpenAI } from "@/server/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/images/generations (also /v1/…) — OpenAI-compatible, sd15 only, `Authorization: Bearer sck_…`.
 * Answers 202 with an empty `data` and `sparecycle.poll`; `Prefer: wait=<s>` may return the image (200).
 */
export const POST = handleOpenAI(async (req: Request) => createImage(req));
