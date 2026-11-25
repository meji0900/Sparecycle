// GPU allowlist: which device families may take jobs. Families are admitted only after a published bench passes
// against the live thresholds (bench/results/, docs/gpu-support.md). The rules live in gpu-allowlist.json:
//   allowed  -> the node is eligible for jobs (subject to the challenge, src/server/challenge.ts)
//   untested -> it registers, but with GPU_ALLOWLIST_MODE=enforce it gets no jobs (challenges only)
//   blocked  -> with GPU_ALLOWLIST_MODE=enforce registration is refused (403 gpu-not-supported)
// The device name and info are self-reported, so classification is a filter, not a proof: the challenge is the gate
// that checks what the device actually computes.
import { isBackend, type Backend, type DeviceInfo } from "@/lib/protocol";
import data from "./gpu-allowlist.json" with { type: "json" };

export type GpuClass = "allowed" | "blocked" | "untested";
/** What the scheduler stores in nodes.gpu_status. */
export type GpuStatus = "eligible" | "untested" | "blocked";
export type Classification = { family: string; status: GpuClass; rule: string };

type RawRule = {
  id: string;
  backends: string[];
  name?: string;
  vulkanDeviceType?: string;
  computeCap?: string[];
  family: string;
  status: string;
};
type Rule = Omit<RawRule, "name" | "status"> & { name: RegExp | null; status: GpuClass };

const CLASSES: readonly string[] = ["allowed", "blocked", "untested"];
const isClass = (v: unknown): v is GpuClass => typeof v === "string" && CLASSES.includes(v);

/** Compiles and checks the rules file. Throws on a malformed rule, so a bad edit fails at boot and in the tests. */
export function compileAllowlist(raw: { rules: RawRule[]; fallback: Record<string, { family: string; status: string }> }) {
  const rules: Rule[] = raw.rules.map((r) => {
    if (!r.id || !r.family || !isClass(r.status)) throw new Error(`gpu-allowlist: rule ${r.id ?? "?"} needs id, family and a valid status`);
    if (!Array.isArray(r.backends) || !r.backends.every((b) => b === "*" || isBackend(b))) {
      throw new Error(`gpu-allowlist: rule ${r.id} has an unknown backend`);
    }
    if (!r.name && !r.vulkanDeviceType) throw new Error(`gpu-allowlist: rule ${r.id} needs name or vulkanDeviceType`);
    return { ...r, name: r.name ? new RegExp(r.name, "i") : null, status: r.status };
  });
  const fallback = {} as Record<Backend, { family: string; status: GpuClass }>;
  for (const b of ["cuda", "vulkan", "cpu"] as const) {
    const f = raw.fallback[b];
    if (!f || !f.family || !isClass(f.status)) throw new Error(`gpu-allowlist: fallback for ${b} is missing or invalid`);
    fallback[b] = { family: f.family, status: f.status };
  }
  return { rules, fallback };
}

const ALLOWLIST = compileAllowlist(data as Parameters<typeof compileAllowlist>[0]);

/** Public list of supported GPUs (linked from the 403 gpu-not-supported answer). */
export const GPU_SUPPORT_URL: string = data.supportDoc;

function matches(rule: Rule, backend: Backend, names: string[], device: DeviceInfo | null | undefined): boolean {
  if (!rule.backends.includes("*") && !rule.backends.includes(backend)) return false;
  if (rule.name && !names.some((n) => rule.name!.test(n))) return false;
  if (rule.vulkanDeviceType && device?.vulkan?.deviceType !== rule.vulkanDeviceType) return false;
  // A reported compute capability must fit the family (a name alone is easy to fake; both together a little less).
  if (rule.computeCap && device?.computeCap && !rule.computeCap.includes(device.computeCap)) return false;
  return true;
}

/**
 * Family and status of a device. `gpu` is the reported name (nvidia-smi / vulkaninfo / CPU model); `device` the
 * structured info of node client 0.3.0+ (absent for older nodes). Dev-runner nodes (no GPU, accepted only when
 * SCHEDULER_ALLOW_DEV_RUNNER=1 for local tests) are their own family.
 */
export function classifyDevice(input: { backend: Backend; gpu: string; device?: DeviceInfo | null; dev?: boolean }): Classification {
  if (input.dev) return { family: "dev-runner", status: "allowed", rule: "dev-runner" };
  const names = [input.gpu, input.device?.vulkan?.deviceName].filter((n): n is string => typeof n === "string" && n.length > 0);
  for (const r of ALLOWLIST.rules) {
    if (matches(r, input.backend, names, input.device)) return { family: r.family, status: r.status, rule: r.id };
  }
  const f = ALLOWLIST.fallback[input.backend];
  return { family: f.family, status: f.status, rule: `fallback-${input.backend}` };
}

export const gpuStatusOf = (c: GpuClass): GpuStatus => (c === "allowed" ? "eligible" : c);

const MAX_FIELD = 128;
const field = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, MAX_FIELD) : undefined;

/** Keeps the known DeviceInfo fields (strings, capped), drops anything else. Never throws: the field is optional. */
export function sanitizeDeviceInfo(v: unknown): DeviceInfo | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: DeviceInfo = {};
  for (const k of ["vendor", "computeCap", "driver", "cpu"] as const) {
    const s = field(o[k]);
    if (s) out[k] = s;
  }
  if (typeof o.vulkan === "object" && o.vulkan !== null && !Array.isArray(o.vulkan)) {
    const vk = o.vulkan as Record<string, unknown>;
    const vout: NonNullable<DeviceInfo["vulkan"]> = {};
    for (const k of ["vendorId", "deviceId", "deviceType", "deviceName", "driverName", "driverInfo", "apiVersion"] as const) {
      const s = field(vk[k]);
      if (s) vout[k] = s;
    }
    if (Object.keys(vout).length) out.vulkan = vout;
  }
  return Object.keys(out).length ? out : null;
}
