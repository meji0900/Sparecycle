import { privateJson } from "@/server/http";
import { handleOpenAI, modelsList } from "@/server/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/models (also /v1/models) — exactly qwen2.5-1.5b and sd15, OpenAI list shape. Needs an API key. */
export const GET = handleOpenAI(async (req: Request) => privateJson(modelsList(req)));
