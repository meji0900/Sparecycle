// Unit tests: GPU allowlist rules (src/server/gpu-allowlist.json via classifyDevice). Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyDevice, compileAllowlist, gpuStatusOf, sanitizeDeviceInfo } from "./gpu-allowlist";

const cls = (backend: "cuda" | "vulkan" | "cpu", gpu: string, device?: Parameters<typeof classifyDevice>[0]["device"]) => {
  const c = classifyDevice({ backend, gpu, device });
  return `${c.family}/${c.status}`;
};

describe("classifyDevice", () => {
  test("benched CUDA families are allowed (RTX 30 Ampere, RTX 40 Ada, desktop and laptop names)", () => {
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 3060"), "nvidia-rtx30-ampere/allowed");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 3090 Ti"), "nvidia-rtx30-ampere/allowed");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 3050 Laptop GPU"), "nvidia-rtx30-ampere/allowed");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 4060"), "nvidia-rtx40-ada/allowed");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 4090 Laptop GPU"), "nvidia-rtx40-ada/allowed");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 3060", { computeCap: "8.6" }), "nvidia-rtx30-ampere/allowed");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 4070 SUPER", { computeCap: "8.9" }), "nvidia-rtx40-ada/allowed");
  });

  test("a reported compute capability that does not fit the family drops to untested", () => {
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 3060", { computeCap: "7.5" }), "cuda-other/untested");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 4060", { computeCap: "8.6" }), "cuda-other/untested");
  });

  test("RTX 50 (Blackwell) and RTX 20 (Turing) are untested until benched", () => {
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 5090"), "nvidia-rtx50-blackwell/untested");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 5060 Ti"), "nvidia-rtx50-blackwell/untested");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 2080 Ti"), "nvidia-rtx20-turing/untested");
    assert.equal(cls("cuda", "NVIDIA GeForce RTX 2060 SUPER"), "nvidia-rtx20-turing/untested");
  });

  test("any other CUDA device is untested (workstation, datacenter, GTX, unknown names)", () => {
    for (const name of ["NVIDIA RTX A4000", "NVIDIA RTX 4000 Ada Generation", "NVIDIA A100-SXM4-40GB", "Tesla T4", "NVIDIA GeForce GTX 1660 SUPER", "dev box"]) {
      assert.equal(cls("cuda", name), "cuda-other/untested", name);
    }
  });

  test("every Vulkan GPU is untested (no Vulkan reference yet), including NVIDIA cards on Vulkan", () => {
    assert.equal(cls("vulkan", "AMD Radeon RX 7600 (RADV NAVI33) (Vulkan)"), "vulkan-other/untested");
    assert.equal(cls("vulkan", "Intel(R) Arc(tm) A770 Graphics (DG2) (Vulkan)"), "vulkan-other/untested");
    assert.equal(cls("vulkan", "NVIDIA GeForce RTX 3060 (Vulkan)"), "vulkan-other/untested");
    assert.equal(cls("vulkan", "AMD Radeon(TM) Graphics (Vulkan)", { vulkan: { deviceType: "PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU" } }), "vulkan-other/untested");
  });

  test("software rasterizers are blocked, by name or by Vulkan device type", () => {
    assert.equal(cls("vulkan", "llvmpipe (LLVM 15.0.7, 256 bits) (Vulkan)"), "software-rasterizer/blocked");
    assert.equal(cls("vulkan", "Lavapipe (Vulkan)"), "software-rasterizer/blocked");
    assert.equal(cls("vulkan", "SwiftShader Device (Subzero) (Vulkan)"), "software-rasterizer/blocked");
    assert.equal(cls("vulkan", "Microsoft Basic Render Driver (Vulkan)"), "software-rasterizer/blocked");
    assert.equal(cls("vulkan", "Some GPU (Vulkan)", { vulkan: { deviceType: "PHYSICAL_DEVICE_TYPE_CPU" } }), "software-rasterizer/blocked");
    // the structured deviceName counts too, whatever the free-text name says
    assert.equal(cls("vulkan", "AMD Radeon RX 7600 (Vulkan)", { vulkan: { deviceName: "llvmpipe (LLVM 17)" } }), "software-rasterizer/blocked");
    assert.equal(cls("cuda", "llvmpipe"), "software-rasterizer/blocked");
  });

  test("the cpu backend is untested; a CPU model name never matches a GPU rule", () => {
    assert.equal(cls("cpu", "AMD Ryzen 7 5700U with Radeon Graphics (CPU)"), "cpu/untested");
    assert.equal(cls("cpu", "NVIDIA GeForce RTX 3060"), "cpu/untested");
  });

  test("dev-runner nodes are their own family", () => {
    assert.deepEqual(classifyDevice({ backend: "cuda", gpu: "dev-runner (no GPU, cuda)", dev: true }), {
      family: "dev-runner",
      status: "allowed",
      rule: "dev-runner",
    });
  });

  test("allowlist status maps to the stored gpu_status", () => {
    assert.equal(gpuStatusOf("allowed"), "eligible");
    assert.equal(gpuStatusOf("untested"), "untested");
    assert.equal(gpuStatusOf("blocked"), "blocked");
  });

  test("a malformed rules file is rejected", () => {
    const fallback = { cuda: { family: "a", status: "untested" }, vulkan: { family: "b", status: "untested" }, cpu: { family: "c", status: "untested" } };
    assert.throws(() => compileAllowlist({ rules: [{ id: "x", backends: ["cuda"], name: "x", family: "f", status: "maybe" }], fallback }));
    assert.throws(() => compileAllowlist({ rules: [{ id: "x", backends: ["metal"], name: "x", family: "f", status: "allowed" }], fallback }));
    assert.throws(() => compileAllowlist({ rules: [{ id: "x", backends: ["cuda"], family: "f", status: "allowed" }], fallback }));
    assert.throws(() => compileAllowlist({ rules: [], fallback: { cuda: fallback.cuda, vulkan: fallback.vulkan } as never }));
  });
});

describe("sanitizeDeviceInfo", () => {
  test("keeps known string fields, caps their length, drops the rest", () => {
    const d = sanitizeDeviceInfo({
      vendor: "nvidia",
      computeCap: "8.6",
      driver: "x".repeat(500),
      extra: "dropped",
      vulkan: { vendorId: "0x1002", deviceType: "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU", junk: 1, deviceName: 42 },
    });
    assert.deepEqual(d, {
      vendor: "nvidia",
      computeCap: "8.6",
      driver: "x".repeat(128),
      vulkan: { vendorId: "0x1002", deviceType: "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU" },
    });
  });

  test("anything that is not an object gives null", () => {
    for (const v of [undefined, null, "rtx", 3, [], {}]) assert.equal(sanitizeDeviceInfo(v), null);
  });
});
