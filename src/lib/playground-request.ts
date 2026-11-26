// The job requests the playground (src/components/dapp/playground.tsx) sends: exactly the objects POST /api/v1/jobs takes,
// free as they are, or paid as { request, payment } with the wallet's signature over this same object. Kept apart from the
// component so the tests (src/server/serverless.test.ts, scripts/e2e-local.mjs) send byte-for-byte what the browser sends.
import type { ModelId } from "./protocol";

export type ImageSettings = { prompt: string; negative: string; width: number; height: number; steps: number; guidance: number; seed: number | null };
export type TextSettings = { prompt: string; system: string; maxTokens: number };

/** Answer lengths offered for the text model (maxTokens). The price counts the limit, not the tokens written. */
export const TEXT_LENGTHS = {
  short: { title: "Short", maxTokens: 128, sub: "Up to 128 tokens" },
  medium: { title: "Medium", maxTokens: 256, sub: "Up to 256 tokens" },
  long: { title: "Long", maxTokens: 512, sub: "Up to 512 tokens" },
} as const;
export type TextLength = keyof typeof TEXT_LENGTHS;

/** An image job request (sd15). The seed is left out when null: the scheduler picks one. */
export const imageJobRequest = (s: ImageSettings) => ({
  kind: "image" as const,
  params: {
    model: "sd15" as const,
    prompt: s.prompt,
    negative: s.negative,
    width: s.width,
    height: s.height,
    steps: s.steps,
    guidance: s.guidance,
    ...(s.seed !== null ? { seed: s.seed } : {}),
  },
});

/** A text job request (qwen2.5-1.5b). Decoding is greedy on the nodes. */
export const textJobRequest = (s: TextSettings) => ({
  kind: "text" as const,
  params: { model: "qwen2.5-1.5b" as const, prompt: s.prompt, system: s.system, maxTokens: s.maxTokens },
});

/** The model the playground uses for each kind of job (MODELS has one per kind; parseJobRequest enforces it). */
export const PLAYGROUND_MODEL: Record<"image" | "text", ModelId> = { image: "sd15", text: "qwen2.5-1.5b" };
