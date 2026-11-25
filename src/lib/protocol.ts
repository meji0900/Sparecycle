// Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) — see NOTICE.
//
// Sparecycle wire protocol: the two MVP models, job specs and their validation, scheduler-computed work
// units, request signing (EIP-191) and node receipts (EIP-712).
//
// Shared by the scheduler (this Next.js app), the browser (job form, node guide) and the node client.
// `node-client/src/protocol.ts` is a byte-identical copy (the node client ships standalone);
// `scripts/e2e-local.mjs` fails if the two drift. Keep this file browser-safe: viem only, no `node:` imports,
// and erasable TypeScript only (no enums / namespaces / parameter properties) so Node can run the copy.
import {
  getAddress,
  isAddress,
  recoverMessageAddress,
  recoverTypedDataAddress,
  sha256,
  stringToBytes,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";

export const PROTOCOL_VERSION = 1;

// ---- Compute backends ------------------------------------------------------------------------------
/**
 * How a node runs its models. `cuda` = NVIDIA (both models); `vulkan` = any Vulkan GPU incl. AMD / Intel iGPUs,
 * and `cpu` = llama.cpp on the CPU (text model only). The two tasks of a job always go to nodes with the SAME
 * backend: floating-point differences between CUDA, Vulkan and CPU kernels could otherwise make honest results
 * disagree.
 */
export const BACKENDS = ["cuda", "vulkan", "cpu"] as const;
export type Backend = (typeof BACKENDS)[number];
export const isBackend = (v: unknown): v is Backend => typeof v === "string" && (BACKENDS as readonly string[]).includes(v);

// ---- Models (MVP: exactly two, no model picker beyond this list) ---------------------------------
export const MODELS = {
  sd15: {
    kind: "image",
    tag: "image:sd15",
    vramMb: 4_000,
    backends: ["cuda"],
    label: "Stable Diffusion 1.5",
    license: "CreativeML OpenRAIL-M",
    source: "stable-diffusion-v1-5/stable-diffusion-v1-5",
  },
  "qwen2.5-1.5b": {
    kind: "text",
    tag: "text:qwen2.5-1.5b",
    vramMb: 2_000,
    backends: ["cuda", "vulkan", "cpu"],
    label: "Qwen2.5-1.5B-Instruct (GGUF Q4_K_M, llama.cpp)",
    license: "Apache-2.0",
    source: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
  },
} as const;

export type ModelId = keyof typeof MODELS;
export type ImageModel = "sd15";
export type TextModel = "qwen2.5-1.5b";
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];
export const CAPABILITY_TAGS: string[] = MODEL_IDS.map((m) => MODELS[m].tag);

/** Can `backend` run `model`? (SD 1.5 is CUDA-only; the text model runs on every backend.) */
export const modelRunsOn = (model: ModelId, backend: Backend): boolean =>
  (MODELS[model].backends as readonly Backend[]).includes(backend);

/** Capability tags a node on `backend` may advertise. */
export const capabilityTagsFor = (backend: Backend): string[] =>
  MODEL_IDS.filter((m) => modelRunsOn(m, backend)).map((m) => MODELS[m].tag);

export const LIMITS = {
  image: {
    prompt: { min: 1, max: 500 },
    negative: { min: 0, max: 300 },
    side: { min: 256, max: 512, step: 64 },
    steps: { min: 10, max: 30 },
    guidance: { min: 1, max: 12, default: 7 },
    seed: { min: 0, max: 0xffff_ffff },
  },
  text: {
    prompt: { min: 1, max: 2_000 },
    system: { min: 0, max: 500 },
    maxTokens: { min: 16, max: 512 },
  },
} as const;

export type ImageParams = {
  model: ImageModel;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  /** uint32. Chosen by the scheduler when the submitter leaves it out, so both nodes render the same image. */
  seed: number;
};

/** Text jobs always use greedy decoding (temperature 0, top_k 1), so two nodes give (nearly) the same text. */
export type TextParams = {
  model: TextModel;
  prompt: string;
  system: string;
  maxTokens: number;
};

export type JobSpec = { kind: "image"; params: ImageParams } | { kind: "text"; params: TextParams };
export type JobKind = JobSpec["kind"];

/** A submitted job before the scheduler fills in the seed. */
export type JobRequest =
  | { kind: "image"; params: Omit<ImageParams, "seed"> & { seed: number | null } }
  | { kind: "text"; params: TextParams };

export const JOB_STATUSES = ["queued", "running", "checking", "agreed", "disagreed", "expired", "rejected"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export class SpecError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "SpecError";
    this.field = field;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function text(p: Obj, key: string, lim: { min: number; max: number }, fallback?: string): string {
  const v = p[key] ?? fallback;
  if (typeof v !== "string") throw new SpecError(key, `${key} must be text`);
  if (v.length < lim.min || v.length > lim.max) {
    throw new SpecError(key, `${key} must be ${lim.min}..${lim.max} characters`);
  }
  // Content guard: no NUL / control characters other than tab and newlines.
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) {
      throw new SpecError(key, `${key} contains control characters`);
    }
  }
  if (lim.min > 0 && v.trim().length === 0) throw new SpecError(key, `${key} must not be blank`);
  return v;
}

function int(p: Obj, key: string, lim: { min: number; max: number; step?: number }): number {
  const v = p[key];
  const step = lim.step ?? 1;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lim.min || v > lim.max || v % step !== 0) {
    throw new SpecError(key, `${key} must be a whole number in ${lim.min}..${lim.max}${step > 1 ? ` in steps of ${step}` : ""}`);
  }
  return v;
}

function parse(body: unknown, seedRequired: boolean): JobRequest {
  if (!isObj(body)) throw new SpecError("body", "expected a JSON object");
  const p = body.params;
  if (!isObj(p)) throw new SpecError("params", "params must be an object");
  if (body.kind === "image") {
    if (p.model !== "sd15") throw new SpecError("model", "image model must be sd15");
    const L = LIMITS.image;
    const g = p.guidance ?? L.guidance.default;
    if (typeof g !== "number" || !Number.isFinite(g) || g < L.guidance.min || g > L.guidance.max) {
      throw new SpecError("guidance", `guidance must be a number in ${L.guidance.min}..${L.guidance.max}`);
    }
    const seed = p.seed === undefined || p.seed === null ? null : int(p, "seed", L.seed);
    if (seedRequired && seed === null) throw new SpecError("seed", "seed is required");
    return {
      kind: "image",
      params: {
        model: "sd15",
        prompt: text(p, "prompt", L.prompt),
        negative: text(p, "negative", L.negative, ""),
        width: int(p, "width", L.side),
        height: int(p, "height", L.side),
        steps: int(p, "steps", L.steps),
        guidance: Math.round(g * 100) / 100,
        seed,
      },
    };
  }
  if (body.kind === "text") {
    if (p.model !== "qwen2.5-1.5b") throw new SpecError("model", "text model must be qwen2.5-1.5b");
    const L = LIMITS.text;
    return {
      kind: "text",
      params: {
        model: "qwen2.5-1.5b",
        prompt: text(p, "prompt", L.prompt),
        system: text(p, "system", L.system, ""),
        maxTokens: int(p, "maxTokens", L.maxTokens),
      },
    };
  }
  throw new SpecError("kind", "kind must be image or text");
}

/** Validates a job submission (`POST /api/v1/jobs` body). The image seed may be left out. */
export function parseJobRequest(body: unknown): JobRequest {
  return parse(body, false);
}

/** Validates a complete job spec (what a node receives). Throws SpecError. */
export function validateSpec(spec: unknown): JobSpec {
  return parse(spec, true) as JobSpec;
}

/** Model, capability tag and VRAM a job needs. */
export function needs(spec: JobSpec | JobRequest): { model: ModelId; tag: string; vramMb: number } {
  const m = MODELS[spec.params.model];
  return { model: spec.params.model, tag: m.tag, vramMb: m.vramMb };
}

/**
 * Work units of a job: estimated milliseconds on a reference RTX 3060-class GPU. Computed by the scheduler
 * from the spec, never reported by a node, so a node can't inflate its share. Payouts are pro rata by units.
 *   image: 512x512 at 20 steps = 3,200 units, scaled by pixels x steps
 *   text:  8 per max token + 1 per 16 prompt/system characters
 */
export function workUnits(spec: JobSpec | JobRequest): number {
  if (spec.kind === "image") {
    const p = spec.params;
    return Math.max(1, Math.ceil((p.width * p.height * p.steps * 160) / (512 * 512)));
  }
  const p = spec.params;
  return Math.max(1, p.maxTokens * 8 + Math.ceil((p.prompt.length + p.system.length) / 16));
}

// ---- Hashing -----------------------------------------------------------------------------------------
/** sha256 of bytes, or of the UTF-8 encoding of a string. */
export const sha256Hex = (data: Uint8Array | string): Hex =>
  sha256(typeof data === "string" ? stringToBytes(data) : data);

/**
 * Public hash of a job's prompt (the prompt itself stays private on the scheduler). Salted with the job id
 * so identical prompts don't link across jobs; the submitter, who knows both, can recompute it.
 */
export const promptHashOf = (jobId: Hex, prompt: string): Hex => sha256Hex(`sparecycle-prompt|${jobId.toLowerCase()}|${prompt}`);

// ---- Node <-> scheduler request signing (EIP-191) ----------------------------------------------------
export const SIGNED_HEADERS = { from: "x-sc-from", ts: "x-sc-ts", sig: "x-sc-sig" } as const;
/** Max clock skew of a signed request, seconds. The scheduler remembers signatures for twice this long. */
export const REQUEST_WINDOW_SECONDS = 60;

/**
 * Random nonce for node request bodies (`{ ...body, nonce }`). Signatures are deterministic, so without it two
 * identical requests in the same second (e.g. two empty polls) would share a signature and the scheduler, which
 * accepts each signature once, would reject the second as a replay.
 */
export const requestNonce = (): string => {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

/** The EIP-191 message a node signs for each request: sparecycle|METHOD|PATH|TS|sha256(body). */
export const requestMessage = (method: string, path: string, ts: string, body: string) =>
  `sparecycle|${method.toUpperCase()}|${path}|${ts}|${sha256Hex(body)}`;

export async function signRequest(
  account: LocalAccount,
  method: string,
  path: string,
  body: string,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  const ts = String(Math.floor(nowMs / 1000));
  const sig = await account.signMessage({ message: requestMessage(method, path, ts, body) });
  return {
    "content-type": "application/json",
    [SIGNED_HEADERS.from]: account.address,
    [SIGNED_HEADERS.ts]: ts,
    [SIGNED_HEADERS.sig]: sig,
  };
}

export type SignedRequestCheck =
  | { ok: true; signer: Address; ts: number; sig: Hex }
  | { ok: false; error: "missing-signature" | "stale-request" | "bad-signature"; message: string };

/** Checks the x-sc-* headers of a node request. Replay protection (remembering signatures) is the caller's job. */
export async function checkSignedRequest(input: {
  from: string | null;
  ts: string | null;
  sig: string | null;
  method: string;
  path: string;
  body: string;
  nowMs?: number;
}): Promise<SignedRequestCheck> {
  const { from, ts, sig } = input;
  if (!from || !ts || !sig || !isAddress(from) || !/^\d{1,12}$/.test(ts) || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    return { ok: false, error: "missing-signature", message: "x-sc-from, x-sc-ts and x-sc-sig headers are required" };
  }
  const now = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(now - Number(ts)) > REQUEST_WINDOW_SECONDS) {
    return { ok: false, error: "stale-request", message: `request timestamp is outside the ${REQUEST_WINDOW_SECONDS} s window` };
  }
  try {
    const signer = await recoverMessageAddress({
      message: requestMessage(input.method, input.path, ts, input.body),
      signature: sig as Hex,
    });
    if (signer.toLowerCase() !== from.toLowerCase()) {
      return { ok: false, error: "bad-signature", message: "signature does not match x-sc-from" };
    }
    return { ok: true, signer: getAddress(signer), ts: Number(ts), sig: sig.toLowerCase() as Hex };
  } catch {
    return { ok: false, error: "bad-signature", message: "signature could not be recovered" };
  }
}

/**
 * The owner wallet signs this once (EIP-191 personal_sign, no gas) to link a node key to it. The owner wallet
 * is the account in the payout Merkle leaf; the node key only signs requests and receipts, so the node
 * client never needs the owner's private key.
 */
export const linkMessage = (nodeKey: string, owner: string) =>
  `Sparecycle: link node ${nodeKey.toLowerCase()} to wallet ${owner.toLowerCase()}`;

// ---- Receipts (EIP-712) --------------------------------------------------------------------------------
/** A node's signed statement: "I ran job X in epoch E and got output hash H in G ms". */
export type Receipt = { jobId: Hex; node: Address; outputHash: Hex; gpuMs: bigint; epoch: bigint };

/** EIP-712 domain of node receipts. `chainId` = the target chain of the deployment (4663 on mainnet). */
export const receiptDomain = (chainId: number) => ({ name: "Sparecycle", version: "1", chainId }) as const;

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "jobId", type: "bytes32" },
    { name: "node", type: "address" },
    { name: "outputHash", type: "bytes32" },
    { name: "gpuMs", type: "uint64" },
    { name: "epoch", type: "uint64" },
  ],
} as const;

export const signReceipt = (account: LocalAccount, chainId: number, r: Receipt) =>
  account.signTypedData({ domain: receiptDomain(chainId), types: RECEIPT_TYPES, primaryType: "Receipt", message: r });

/** Address that signed a receipt, or null if the signature is malformed. */
export async function recoverReceiptSigner(chainId: number, r: Receipt, signature: Hex): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: receiptDomain(chainId),
      types: RECEIPT_TYPES,
      primaryType: "Receipt",
      message: r,
      signature,
    });
  } catch {
    return null;
  }
}

/** JSON with bigint support (bigints become decimal strings). */
export const toJson = (v: unknown, space?: number) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);

// ---- GPU challenge (periodic re-check of a node against published reference fingerprints) -------------
/**
 * Node features, sent at registration in `features` (NOT in `caps`: schedulers before the GPU allowlist validate
 * `caps` strictly and would reject an unknown tag, so a newer node still registers with an older scheduler).
 * "challenge-1": the node runs challenge tasks handed out through the poll. A node without it never gets one.
 */
export const CHALLENGE_FEATURE = "challenge-1";
export const NODE_FEATURES: readonly string[] = [CHALLENGE_FEATURE];

/**
 * Structured device info a node reports at registration (node client 0.3.0+), next to the free-text `gpu` name.
 * Self-reported, so the scheduler uses it to classify the device, never as proof of the hardware.
 */
export type DeviceInfo = {
  /** nvidia | amd | intel | software | other */
  vendor?: string;
  /** CUDA compute capability from nvidia-smi, e.g. "8.6". */
  computeCap?: string;
  /** NVIDIA driver version from nvidia-smi. */
  driver?: string;
  /** The Vulkan device the node uses, from `vulkaninfo --summary`. */
  vulkan?: {
    vendorId?: string;
    deviceId?: string;
    deviceType?: string;
    deviceName?: string;
    driverName?: string;
    driverInfo?: string;
    apiVersion?: string;
  };
  /** CPU model (cpu backend). */
  cpu?: string;
};

/**
 * A challenge handed out by the poll instead of a job (only to nodes that advertise CHALLENGE_FEATURE): one fixed
 * case of the published bench suite. Unpaid, never charged, never a job, never in a payout tree.
 */
export type ChallengeAssignment = {
  type: "challenge";
  challengeId: Hex;
  suite: number;
  caseId: string;
  spec: JobSpec;
  chainId: number;
  leaseExpiresAt: number;
};

/** A node's signed challenge answer. A separate EIP-712 type, so it can never be mistaken for a job receipt. */
export type ChallengeReceipt = { challengeId: Hex; node: Address; outputHash: Hex; gpuMs: bigint };

export const CHALLENGE_TYPES = {
  ChallengeResult: [
    { name: "challengeId", type: "bytes32" },
    { name: "node", type: "address" },
    { name: "outputHash", type: "bytes32" },
    { name: "gpuMs", type: "uint64" },
  ],
} as const;

export const signChallengeResult = (account: LocalAccount, chainId: number, r: ChallengeReceipt) =>
  account.signTypedData({ domain: receiptDomain(chainId), types: CHALLENGE_TYPES, primaryType: "ChallengeResult", message: r });

/** Address that signed a challenge answer, or null if the signature is malformed. */
export async function recoverChallengeSigner(chainId: number, r: ChallengeReceipt, signature: Hex): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: receiptDomain(chainId),
      types: CHALLENGE_TYPES,
      primaryType: "ChallengeResult",
      message: r,
      signature,
    });
  } catch {
    return null;
  }
}
