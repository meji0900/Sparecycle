// Dev runner: deterministic synthetic outputs with NO GPU and NO model, for local end-to-end tests of the
// scheduler and the payout path only. Two dev nodes given the same job return identical outputs, so the job
// "agrees". Results are flagged `dev: true`; a real scheduler rejects them (SCHEDULER_ALLOW_DEV_RUNNER is a
// local-test switch) and they are never paid on a real network.
import { PNG } from "pngjs";
import { sha256Hex, type ImageParams, type TextParams } from "#protocol";

export const DEV_BANNER = [
  "",
  "################################################################################",
  "#  DEV RUNNER: no GPU, no model. Outputs are synthetic and deterministic.      #",
  "#  For local end-to-end tests only. A real Sparecycle scheduler rejects dev    #",
  "#  results, and they are NEVER paid on a real network.                         #",
  "################################################################################",
  "",
].join("\n");

/** mulberry32: small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (hex: string) => Number.parseInt(hex.slice(2, 10), 16);

/** A PNG of the requested size rendered from the seed and the prompt hash (gradient + discs). */
export function devImage(p: ImageParams): { png: Buffer; gpuMs: number; nsfw: boolean } {
  const t0 = performance.now();
  const rand = prng(p.seed ^ seedOf(sha256Hex(p.prompt)));
  const png = new PNG({ width: p.width, height: p.height });
  const c0 = [rand() * 255, rand() * 255, rand() * 255];
  const c1 = [rand() * 255, rand() * 255, rand() * 255];
  const discs = Array.from({ length: 6 }, () => ({
    x: rand() * p.width,
    y: rand() * p.height,
    r: 20 + rand() * (p.width / 4),
    c: [rand() * 255, rand() * 255, rand() * 255],
  }));
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const t = (x + y) / (p.width + p.height);
      let rgb = [0, 1, 2].map((i) => c0[i] * (1 - t) + c1[i] * t);
      for (const d of discs) {
        if ((x - d.x) ** 2 + (y - d.y) ** 2 < d.r ** 2) rgb = rgb.map((v, i) => (v + d.c[i]) / 2);
      }
      const o = (y * p.width + x) * 4;
      png.data[o] = Math.round(rgb[0]);
      png.data[o + 1] = Math.round(rgb[1]);
      png.data[o + 2] = Math.round(rgb[2]);
      png.data[o + 3] = 255;
    }
  }
  const buf = PNG.sync.write(png, { colorType: 6 });
  return { png: buf, gpuMs: performance.now() - t0, nsfw: false };
}

/**
 * SPARECYCLE_DEV_CORRUPT=1: a dev runner that returns WRONG outputs for job tasks, to test the scheduler's re-check
 * rounds (a mismatch moves a paid job to another pair). Honoured only with --dev-runner, and never for GPU challenges
 * (a corrupting dev node still passes its challenge and gets jobs). Its outputs are seeded by its own node key, so
 * they match neither an honest dev output nor another corrupting node's.
 */
export const devCorrupt = (dev: boolean) => dev && process.env.SPARECYCLE_DEV_CORRUPT === "1";

/** A wrong image for this node: per-pixel noise seeded by the node key (its dHash is random against any other). */
export function corruptDevImage(p: ImageParams, nodeKey: string): { png: Buffer; gpuMs: number; nsfw: boolean } {
  const t0 = performance.now();
  const rand = prng(p.seed ^ seedOf(sha256Hex(`corrupt|${nodeKey.toLowerCase()}|${p.prompt}`)));
  const png = new PNG({ width: p.width, height: p.height });
  for (let o = 0; o < png.data.length; o += 4) {
    png.data[o] = Math.floor(rand() * 256);
    png.data[o + 1] = Math.floor(rand() * 256);
    png.data[o + 2] = Math.floor(rand() * 256);
    png.data[o + 3] = 255;
  }
  return { png: PNG.sync.write(png, { colorType: 6 }), gpuMs: performance.now() - t0, nsfw: false };
}

/** A wrong text for this node: random tokens seeded by the node key and the prompt. */
export function corruptDevText(p: TextParams, nodeKey: string): { text: string; gpuMs: number; tokens: number | null; tokensPerSecond: number | null } {
  const rand = prng(seedOf(sha256Hex(`corrupt|${nodeKey.toLowerCase()}|${p.system}\u0000${p.prompt}`)));
  const n = Math.max(8, Math.floor(p.maxTokens / 2));
  const tokens = Array.from({ length: n }, () => Math.floor(rand() * 0xffffffff).toString(36));
  return { text: `[dev-runner CORRUPTED output of ${nodeKey.slice(0, 10)}] ${tokens.join(" ")}`, gpuMs: 1, tokens: null, tokensPerSecond: null };
}

const WORDS = ["spare", "cycle", "idle", "graphics", "card", "epoch", "check", "agree", "root", "proof", "leaf", "node"];

/** Deterministic text from the prompt hash (roughly maxTokens / 2 words). */
export function devText(p: TextParams): { text: string; gpuMs: number; tokens: number | null; tokensPerSecond: number | null } {
  const h = sha256Hex(`${p.system}\u0000${p.prompt}`);
  const rand = prng(seedOf(h));
  const n = Math.max(4, Math.floor(p.maxTokens / 2));
  const words = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  return { text: `[dev-runner synthetic output for prompt ${h.slice(0, 18)}] ${words.join(" ")}.`, gpuMs: 1, tokens: null, tokensPerSecond: null };
}
