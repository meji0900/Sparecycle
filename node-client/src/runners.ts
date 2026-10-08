// Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) — see NOTICE.
//
// AI runners of the node client (the only two MVP models):
// - ImageRunner: a long-lived Python process (python/image_worker.py) running Stable Diffusion 1.5 with its
//   safety checker on.
// - TextRunner: llama.cpp's llama-server with Qwen2.5-1.5B-Instruct (GGUF Q4_K_M), greedy decoding.
// Both report the GPU time of each job (informational: payouts use scheduler-computed work units).
// Paths come from env so the installer can place them anywhere:
//   SPARECYCLE_PYTHON (default .venv python), SPARECYCLE_LLAMA_SERVER (default bin/llama-<backend>/llama-server, one
//   folder per backend so a machine can hold several), SPARECYCLE_MODELS_DIR (models), HF_HOME (models/hf).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Backend, ImageParams, TextParams } from "#protocol";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
export const PATHS = {
  python: process.env.SPARECYCLE_PYTHON ?? join(ROOT, ".venv", isWin ? "Scripts/python.exe" : "bin/python"),
  /** llama-server of a backend: bin/llama-cuda, bin/llama-vulkan or bin/llama-cpu. */
  llamaServer: (backend: Backend) =>
    process.env.SPARECYCLE_LLAMA_SERVER ?? join(ROOT, "bin", `llama-${backend}`, isWin ? "llama-server.exe" : "llama-server"),
  models: process.env.SPARECYCLE_MODELS_DIR ?? join(ROOT, "models"),
  imageWorker: join(ROOT, "python", "image_worker.py"),
};
export const TEXT_MODEL_FILE = "qwen2.5-1.5b-instruct-q4_k_m.gguf";

type WorkerReply = { id?: string; png?: string; gpu_ms?: number; nsfw?: boolean; error?: string; ready?: boolean; gpu?: string };

export type ImageResult = { png: Buffer; gpuMs: number; nsfw: boolean };
export type TextResult = { text: string; gpuMs: number; tokens: number | null; tokensPerSecond: number | null };

export class ImageRunner {
  private proc?: ChildProcess;
  private waiting = new Map<string, (r: WorkerReply) => void>();
  private seq = 0;

  available() {
    return existsSync(PATHS.python) && existsSync(PATHS.imageWorker);
  }

  async start(log: (m: string) => void): Promise<string> {
    const proc = spawn(PATHS.python, [PATHS.imageWorker], {
      env: { ...process.env, HF_HOME: process.env.HF_HOME ?? join(PATHS.models, "hf"), PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    createInterface({ input: proc.stderr! }).on("line", (l) => log(`image worker: ${l}`));
    const lines = createInterface({ input: proc.stdout! });
    const first = await new Promise<WorkerReply>((ok, fail) => {
      proc.once("exit", (code) => fail(new Error(`image worker exited (${code})`)));
      lines.once("line", (l) => ok(JSON.parse(l) as WorkerReply));
    });
    if (!first.ready) throw new Error(first.error ?? "image worker failed to start");
    lines.on("line", (l) => {
      const msg = JSON.parse(l) as WorkerReply;
      if (!msg.id) return;
      this.waiting.get(msg.id)?.(msg);
      this.waiting.delete(msg.id);
    });
    proc.on("exit", (code) => {
      for (const [, cb] of this.waiting) cb({ error: `image worker exited (${code})` });
      this.waiting.clear();
    });
    return first.gpu ?? "";
  }

  run(p: ImageParams): Promise<ImageResult> {
    const proc = this.proc;
    if (!proc?.stdin) return Promise.reject(new Error("image worker not running"));
    const id = String(++this.seq);
    return new Promise((ok, fail) => {
      this.waiting.set(id, (r) =>
        r.error || !r.png ? fail(new Error(r.error ?? "no image")) : ok({ png: Buffer.from(r.png, "base64"), gpuMs: r.gpu_ms ?? 0, nsfw: r.nsfw === true }),
      );
      proc.stdin!.write(JSON.stringify({ id, ...p }) + "\n");
    });
  }

  get pid() {
    return this.proc?.pid;
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
  }
}

export class TextRunner {
  private proc?: ChildProcess;
  private port = 8791 + Math.floor(Math.random() * 1000);
  readonly backend: Backend;

  constructor(backend: Backend = "cuda") {
    this.backend = backend;
  }

  get serverPath() {
    return PATHS.llamaServer(this.backend);
  }

  static modelFile() {
    return join(PATHS.models, TEXT_MODEL_FILE);
  }

  available() {
    return existsSync(this.serverPath) && existsSync(TextRunner.modelFile());
  }

  /** Starts llama-server once (the node serves exactly one text model). */
  async start(log: (m: string) => void) {
    if (this.proc) return;
    // Linux: the CUDA runtime and cuBLAS shipped with llama.cpp sit next to llama-server; put that folder first on
    // LD_LIBRARY_PATH so a system CUDA toolkit can't swap them. Windows loads DLLs from the program folder first.
    const dir = dirname(this.serverPath);
    const env = isWin ? process.env : { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
    // GPU backends offload every layer; the CPU build keeps them on the CPU.
    const ngl = this.backend === "cpu" ? "0" : "99";
    const proc = spawn(
      this.serverPath,
      [
        "-m", TextRunner.modelFile(), "--port", String(this.port), "--host", "127.0.0.1", "-ngl", ngl, "-c", "4096", "--no-webui",
        // -ub 1: the prompt is evaluated one token at a time, with the same mat-vec kernels as generation. Batched
        // prompt kernels split work by the GPU's SM count, so an RTX 3060 and an RTX 4060 rounded differently and their
        // greedy answers split at near-ties (5/10 agreed); with -ub 1 they gave identical text (10/10). Bench, 22 Nov 2026.
        "-ub", "1",
        // Experiments only (bench): extra llama-server flags. A real node must not change kernels its partner doesn't use.
        ...(process.env.SPARECYCLE_LLAMA_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      ],
      { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    this.proc = proc;
    createInterface({ input: proc.stderr! }).on("line", (l) => {
      if (/error|failed/i.test(l)) log(`llama-server: ${l}`);
    });
    for (let i = 0; i < 120; i++) {
      const ok = await fetch(`http://127.0.0.1:${this.port}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.stop();
    throw new Error("llama-server did not start");
  }

  async run(p: TextParams, log: (m: string) => void): Promise<TextResult> {
    await this.start(log);
    const messages = [...(p.system ? [{ role: "system", content: p.system }] : []), { role: "user", content: p.prompt }];
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Greedy decoding with a fixed seed so the second node gives (nearly) the same text.
      body: JSON.stringify({ messages, max_tokens: p.maxTokens, temperature: 0, top_k: 1, seed: 0, cache_prompt: false }),
    });
    if (!res.ok) throw new Error(`llama-server ${res.status}`);
    const out = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      timings?: { predicted_ms?: number; prompt_ms?: number; predicted_n?: number; predicted_per_second?: number };
    };
    const gpuMs = out.timings ? (out.timings.predicted_ms ?? 0) + (out.timings.prompt_ms ?? 0) : performance.now() - t0;
    return {
      text: out.choices?.[0]?.message?.content ?? "",
      gpuMs,
      tokens: out.timings?.predicted_n ?? null,
      tokensPerSecond: out.timings?.predicted_per_second ?? null,
    };
  }

  get pid() {
    return this.proc?.pid;
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
  }
}
