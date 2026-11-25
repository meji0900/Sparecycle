// Agreement benchmark: runs a fixed set of image and text jobs (fixed prompts, seeds and settings, the same ones on
// every machine) and writes the outputs, timings and device details to a folder. Comparing the folders of two
// devices (scripts/compare-bench.mjs in the Sparecycle repo) shows whether two honest nodes on different hardware
// would pass the scheduler's two-node check, and how much margin the thresholds have.
//
//   node src/agent.ts bench [--backend cuda|vulkan|cpu] [--out folder] [--repeat 2] [--no-image] [--no-text]
//
// Nothing is sent anywhere. Image jobs need --backend cuda (Stable Diffusion 1.5 runs on NVIDIA only).
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Backend, ImageParams, TextParams } from "#protocol";
import { probeDevice, vulkanDevice } from "#gpu";
import { ImageRunner, PATHS, TextRunner } from "#runners";

const run = promisify(execFile);

/** Bump when the suite changes: results of different suite versions are not comparable. */
export const BENCH_SUITE = 1;

type ImageCase = { id: string; control?: string } & Omit<ImageParams, "model" | "negative"> & { negative?: string };
type TextCase = { id: string } & Omit<TextParams, "model" | "system"> & { system?: string };

const img = (id: string, prompt: string, seed: number, extra: Partial<ImageCase> = {}): ImageCase => ({
  id,
  prompt,
  seed,
  width: 512,
  height: 512,
  steps: 20,
  guidance: 7,
  ...extra,
});

/** Same prompts and seeds on every device. `control` = same prompt as another case with the next seed: the closest a
 *  wrong answer can look, so the gap between "same job" and "control" distances is the threshold's real margin. */
export const IMAGE_SUITE: ImageCase[] = [
  img("lighthouse", "a lighthouse on a rocky coast at dusk, oil painting", 1001),
  img("lighthouse-seed2", "a lighthouse on a rocky coast at dusk, oil painting", 1002, { control: "lighthouse" }),
  img("bicycle", "a red bicycle leaning against a brick wall, photo", 2002),
  img("ramen", "a bowl of ramen on a wooden table, top-down photo", 3003),
  img("village", "a snowy mountain village at night with warm windows", 4004),
  img("village-seed2", "a snowy mountain village at night with warm windows", 4005, { control: "village" }),
  img("cat", "an astronaut cat floating in space, digital art", 5005, { negative: "blurry, low quality" }),
  img("sunflowers", "a field of sunflowers under a blue sky, watercolor", 6006, { width: 384, height: 512, steps: 30, guidance: 9 }),
];

/** Short and long answers: greedy decoding drifts most on long outputs. */
export const TEXT_SUITE: TextCase[] = [
  { id: "rainbow", prompt: "Explain how a rainbow forms, in three sentences.", maxTokens: 128 },
  { id: "haiku", prompt: "Write a haiku about a quiet server room.", maxTokens: 64 },
  { id: "laptop", prompt: "List five tips for keeping a laptop cool.", maxTokens: 256 },
  { id: "translate", prompt: "Translate to Indonesian: The network pays only for work that two nodes agree on.", maxTokens: 128 },
  { id: "romeo", prompt: "Summarize the plot of Romeo and Juliet in one paragraph.", maxTokens: 256 },
  { id: "fib", prompt: "Write a Python function that returns the n-th Fibonacci number iteratively, with a docstring.", maxTokens: 256 },
  { id: "gpu-cpu", prompt: "What is the difference between a GPU and a CPU? Explain it to a 12-year-old.", maxTokens: 256 },
  { id: "bakery", prompt: "Give three name ideas for a bakery that sells sourdough.", maxTokens: 128, system: "You are a concise assistant." },
  { id: "merkle", prompt: "Explain what a Merkle tree is and why blockchains use it.", maxTokens: 512 },
  { id: "story", prompt: "Write a short story of about 250 words about a robot that learns to garden.", maxTokens: 512 },
];

export type BenchItem =
  | { id: string; kind: "image"; run: number; gpuMs: number; file: string; nsfw: boolean; control?: string }
  | { id: string; kind: "text"; run: number; gpuMs: number; text: string; tokens: number | null; tokensPerSecond: number | null };

const firstLine = async (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => {
  const r = await run(cmd, args, { timeout: 60_000, windowsHide: true, env }).catch((e: { stdout?: string; stderr?: string }) => e);
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
};

/** What the results depend on: device, driver, compute capability and software versions. */
async function describe(backend: Backend) {
  const dev = await probeDevice(backend);
  const out: Record<string, unknown> = { name: dev.name, vramMb: dev.vramMb };
  if (backend === "cuda") {
    const [l] = await firstLine("nvidia-smi", ["--query-gpu=name,compute_cap,driver_version,memory.total", "--format=csv,noheader,nounits"]);
    const [name, cc, driver, mem] = (l ?? "").split(",").map((s) => s.trim());
    Object.assign(out, { name, computeCap: cc, driver, vramMb: Number(mem) || dev.vramMb });
  } else if (backend === "vulkan") {
    // The same device the node uses (first non-CPU device), not just the first one vulkaninfo lists.
    const vk = await vulkanDevice();
    Object.assign(out, {
      vulkanDriver: vk?.driverName,
      driverInfo: vk?.driverInfo,
      apiVersion: vk?.apiVersion,
      vendorId: vk?.vendorId,
      deviceId: vk?.deviceId,
      deviceType: vk?.deviceType,
    });
  }
  const server = PATHS.llamaServer(backend);
  const ld = platform() === "win32" ? process.env : { ...process.env, LD_LIBRARY_PATH: [dirname(server), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
  const llama = (await firstLine(server, ["--version"], ld)).filter((l) => /^version:|Vulkan\d*:|CUDA\d*:|ggml_cuda|ggml_vulkan/.test(l));
  const software: Record<string, unknown> = { node: process.version, llamaCpp: llama.slice(0, 4) };
  if (backend === "cuda") {
    const py = await firstLine(PATHS.python, [
      "-c",
      "import json,torch,diffusers,transformers;print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'cudnn':torch.backends.cudnn.version(),'diffusers':diffusers.__version__,'transformers':transformers.__version__}))",
    ]);
    try {
      software.python = JSON.parse(py.find((l) => l.startsWith("{")) ?? "null");
    } catch {
      software.python = py.slice(-1);
    }
  }
  return { device: out, software, host: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model?.trim(), ramMb: Math.round(totalmem() / 1048576) } };
}

export async function bench(opts: {
  backend: Backend;
  out: string;
  repeat: number;
  image: boolean;
  text: boolean;
  log: (m: string) => void;
  /** Node client version (bench results are comparable only between the same client settings). */
  client: string;
}) {
  const { backend, out, repeat, log } = opts;
  mkdirSync(out, { recursive: true });
  const info = await describe(backend);
  log(`bench suite ${BENCH_SUITE} on ${String(info.device.name)} (${backend}), ${repeat} run(s) of each job -> ${out}`);
  const items: BenchItem[] = [];
  const save = () =>
    writeFileSync(
      join(out, "bench.json"),
      JSON.stringify({ suite: BENCH_SUITE, createdAt: new Date().toISOString(), backend, client: opts.client, ...info, items }, null, 2) + "\n",
    );

  if (opts.image && backend !== "cuda") log("image jobs skipped: Stable Diffusion 1.5 runs on --backend cuda only");
  if (opts.image && backend === "cuda") {
    const runner = new ImageRunner();
    if (!runner.available()) throw new Error("image worker not installed (run install.sh / install.ps1 for the cuda backend)");
    log("loading Stable Diffusion 1.5 (the first run downloads about 2 GB)");
    await runner.start(log);
    try {
      for (let r = 1; r <= repeat; r++) {
        for (const c of IMAGE_SUITE) {
          const { id, control, ...p } = c;
          const res = await runner.run({ model: "sd15", negative: "", ...p });
          const file = `${id}-r${r}.png`;
          writeFileSync(join(out, file), res.png);
          items.push({ id, kind: "image", run: r, gpuMs: Math.round(res.gpuMs), file, nsfw: res.nsfw, ...(control ? { control } : {}) });
          log(`image ${id} run ${r}: ${(res.gpuMs / 1000).toFixed(1)} s`);
          save();
        }
      }
    } finally {
      runner.stop();
    }
  }

  if (opts.text) {
    const runner = new TextRunner(backend);
    if (!runner.available()) throw new Error(`llama.cpp (${backend}) or the text model is not installed (install with --backend ${backend})`);
    try {
      for (let r = 1; r <= repeat; r++) {
        for (const c of TEXT_SUITE) {
          const { id, ...p } = c;
          const res = await runner.run({ model: "qwen2.5-1.5b", system: "", ...p }, log);
          items.push({ id, kind: "text", run: r, gpuMs: Math.round(res.gpuMs), text: res.text, tokens: res.tokens, tokensPerSecond: res.tokensPerSecond });
          log(`text ${id} run ${r}: ${res.tokens ?? "?"} tokens, ${res.tokensPerSecond?.toFixed(1) ?? "?"} tok/s`);
          save();
        }
      }
    } finally {
      runner.stop();
    }
  }
  save();
  log(`done: ${items.length} results in ${join(out, "bench.json")}`);
}
