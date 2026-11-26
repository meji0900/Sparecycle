// Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) — see NOTICE.
//
// Device probe per backend and the "be a good guest" checks. CUDA: name / UUID / VRAM from nvidia-smi, pause while
// another program uses > 500 MB of VRAM or the GPU is at 83 °C or hotter. Vulkan / CPU: no reliable cross-vendor
// VRAM or temperature reading, so the busy/hot pause is off (the --hours window still applies). The pause is reported
// to the scheduler as a state code only (idle-guard.ts); the readings never leave the machine.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, hostname, totalmem } from "node:os";
import { promisify } from "node:util";
import type { GpuPause } from "#idle-guard";
import type { Backend, DeviceInfo } from "#protocol";

const run = promisify(execFile);

export type Gpu = { name: string; uuid: string; vramMb: number };

/** GPU name, UUID and VRAM from nvidia-smi. SPARECYCLE_GPU_UUID overrides the UUID (local testing only). */
export async function probeGpu(): Promise<Gpu> {
  const { stdout } = await run("nvidia-smi", ["--query-gpu=name,uuid,memory.total", "--format=csv,noheader,nounits"]);
  const [name, uuid, mem] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
  return { name, uuid: process.env.SPARECYCLE_GPU_UUID ?? uuid, vramMb: Number(mem) };
}

export type VulkanDevice = NonNullable<DeviceInfo["vulkan"]> & { deviceName: string };

const VULKAN_KEYS: Record<string, keyof VulkanDevice> = {
  vendorID: "vendorId",
  deviceID: "deviceId",
  deviceType: "deviceType",
  deviceName: "deviceName",
  driverName: "driverName",
  driverInfo: "driverInfo",
  apiVersion: "apiVersion",
};

/** Devices listed by `vulkaninfo --summary` (one "GPUn:" block each, "key = value" lines). */
export function parseVulkanSummary(stdout: string): VulkanDevice[] {
  return stdout
    .split(/\r?\n(?=GPU\d+:)/)
    .filter((b) => /^GPU\d+:/.test(b))
    .map((b) => {
      const d: Partial<VulkanDevice> = {};
      for (const line of b.split(/\r?\n/)) {
        const m = /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(line);
        const key = m ? VULKAN_KEYS[m[1]] : undefined;
        if (m && key && m[2]) d[key] = m[2];
      }
      return d;
    })
    .filter((d): d is VulkanDevice => Boolean(d.deviceName));
}

/** The Vulkan device a node uses: the first non-CPU device (null if vulkaninfo is missing or lists none). */
export async function vulkanDevice(): Promise<VulkanDevice | null> {
  try {
    const { stdout } = await run("vulkaninfo", ["--summary"], { timeout: 20_000, windowsHide: true });
    const devices = parseVulkanSummary(stdout);
    return devices.find((d) => d.deviceType !== "PHYSICAL_DEVICE_TYPE_CPU") ?? devices[0] ?? null;
  } catch {
    return null;
  }
}

/** First non-CPU Vulkan device name from `vulkaninfo --summary` (null if vulkaninfo is missing or lists none). */
export async function vulkanDeviceName(): Promise<string | null> {
  return (await vulkanDevice())?.deviceName ?? null;
}

const VENDORS: Record<string, string> = { "0x10de": "nvidia", "0x1002": "amd", "0x1022": "amd", "0x8086": "intel", "0x10005": "software" };

/**
 * Structured device info sent at registration (node client 0.3.0+): compute capability and driver from nvidia-smi
 * (cuda), the chosen device's vendor / type / driver from vulkaninfo (vulkan), the CPU model (cpu). Never throws: a
 * missing tool just leaves fields out. Self-reported; the scheduler's challenge checks what the device computes.
 */
export async function probeDeviceInfo(backend: Backend): Promise<DeviceInfo> {
  if (backend === "cuda") {
    try {
      const { stdout } = await run("nvidia-smi", ["--query-gpu=compute_cap,driver_version", "--format=csv,noheader,nounits"], {
        timeout: 20_000,
        windowsHide: true,
      });
      const [computeCap, driver] = stdout.trim().split("\n")[0].split(",").map((x) => x.trim());
      return { vendor: "nvidia", ...(computeCap ? { computeCap } : {}), ...(driver ? { driver } : {}) };
    } catch {
      return { vendor: "nvidia" };
    }
  }
  if (backend === "vulkan") {
    const d = await vulkanDevice();
    if (!d) return {};
    const vendor = d.vendorId ? (VENDORS[d.vendorId.toLowerCase()] ?? "other") : undefined;
    return { ...(vendor ? { vendor } : {}), vulkan: d };
  }
  return { cpu: cpus()[0]?.model?.trim() || "unknown CPU" };
}

/**
 * VRAM figure for non-CUDA backends. iGPUs and CPUs use system RAM, which the OS shares with everything else, so the
 * node reports a conservative quarter of system RAM, capped at 4096 MB (the text model needs ~2 GB with a 4k context).
 */
export const sharedMemoryMb = () => Math.min(4096, Math.floor(totalmem() / 1024 / 1024 / 4));

/** Stable device id for non-CUDA nodes: sha256(hostname|cpu model|device name|backend), truncated. */
export function stableDeviceId(backend: Backend, deviceName: string): string {
  const cpu = cpus()[0]?.model?.trim() ?? "unknown-cpu";
  const h = createHash("sha256").update(`${hostname()}|${cpu}|${deviceName}|${backend}`).digest("hex");
  return `${backend}-${h.slice(0, 24)}`;
}

/** Device identity for the chosen backend. */
export async function probeDevice(backend: Backend): Promise<Gpu> {
  if (backend === "cuda") return probeGpu();
  const cpuModel = cpus()[0]?.model?.trim() || "unknown CPU";
  const name = backend === "vulkan" ? ((await vulkanDeviceName()) ?? "Vulkan device (vulkaninfo not found)") : cpuModel;
  return {
    name: backend === "vulkan" ? `${name} (Vulkan)` : `${name} (CPU)`,
    uuid: process.env.SPARECYCLE_GPU_UUID ?? stableDeviceId(backend, name),
    vramMb: sharedMemoryMb(),
  };
}

/** Pause at this GPU temperature or hotter (°C). Fixed: no owner flag in this version (D10, default, not yet confirmed). */
export const HOT_CELSIUS = 83;
/** Pause while another program uses more than this much VRAM (MB). Fixed, like HOT_CELSIUS (D10). */
export const BUSY_VRAM_MB = 500;

/** `nvidia-smi --query-gpu=temperature.gpu` output -> too hot? (first GPU; an unreadable value never pauses) */
export function hotFromSmi(stdout: string): boolean {
  const temp = Number(stdout.trim().split("\n")[0]);
  return Number.isFinite(temp) && temp >= HOT_CELSIUS;
}

/** `nvidia-smi --query-compute-apps=pid,used_memory` output -> does a process that isn't ours use > BUSY_VRAM_MB? */
export function busyFromSmi(stdout: string, ownPids: Set<number>): boolean {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(",").map((s) => s.trim()))
    .some(([pid, mem]) => !ownPids.has(Number(pid)) && Number(mem) > BUSY_VRAM_MB);
}

/**
 * SPARECYCLE_SIMULATE_PAUSE=busy|hot (local testing only): the GPU check reports that reason without reading the GPU,
 * on any backend, so the paused states can be tried end to end (e.g. with --dev-runner).
 */
export function simulatedPause(): GpuPause | null {
  const v = process.env.SPARECYCLE_SIMULATE_PAUSE;
  return v === "busy" ? "paused-busy" : v === "hot" ? "paused-hot" : null;
}

/**
 * Reason to pause as a code (paused-hot | paused-busy), or null. CUDA backend only; without nvidia-smi it never
 * blocks. The readings (temperature, other processes and their VRAM) stay on this machine: only the code is reported.
 */
export async function gpuBusyOrHot(ownPids: Set<number>): Promise<GpuPause | null> {
  const simulated = simulatedPause();
  if (simulated) return simulated;
  if (process.env.SPARECYCLE_NO_BUSY_CHECK === "1") return null;
  try {
    const t = await run("nvidia-smi", ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"]);
    if (hotFromSmi(t.stdout)) return "paused-hot";
    const p = await run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
    if (busyFromSmi(p.stdout, ownPids)) return "paused-busy";
  } catch {
    /* no nvidia-smi: don't block */
  }
  return null;
}

/** Parses --hours "1-8,22-24" (local clock, end exclusive). Throws on a malformed value. */
export function parseHours(spec: string | undefined): [number, number][] | null {
  if (!spec) return null;
  return spec.split(",").map((part) => {
    const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(part);
    const a = m ? Number(m[1]) : NaN;
    const b = m ? Number(m[2]) : NaN;
    if (!m || a > 24 || b > 24 || a === b) throw new Error(`--hours ${part}: use ranges like 1-8,22-24 (0..24, end exclusive)`);
    return [a, b];
  });
}

export function inHours(ranges: [number, number][] | null, now = new Date()): boolean {
  if (!ranges) return true;
  const h = now.getHours();
  return ranges.some(([a, b]) => (a < b ? h >= a && h < b : h >= a || h < b));
}
