"use client";

import { Download, ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import downloads from "@/lib/downloads.json";
import { payoutAssetLabel } from "@/lib/config";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { InstallStep, NodeSetup } from "./node-setup";

export type Os = "windows" | "linux";
export type Backend = "cuda" | "vulkan" | "cpu";

const OS_LABEL: Record<Os, string> = { windows: "Windows", linux: "Linux" };
const BACKEND_LABEL: Record<Backend, string> = { cuda: "NVIDIA GPU", vulkan: "AMD / Intel / iGPU", cpu: "CPU only" };

/** Segmented choice with radio semantics (arrow keys move, Space/Enter select). */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap gap-1 rounded-l border border-line bg-coal p-1"
      onKeyDown={(e) => {
        const i = options.findIndex(([v]) => v === value);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") onChange(options[(i + 1) % options.length][0]);
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") onChange(options[(i - 1 + options.length) % options.length][0]);
      }}
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          tabIndex={value === v ? 0 : -1}
          onClick={() => onChange(v)}
          className={cn(
            "h-9 rounded-m px-4 text-sm transition-colors duration-150",
            value === v ? "bg-text text-coal" : "text-muted hover:text-text",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Req({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-m border border-line bg-coal px-4 py-3">
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-1 text-sm text-text">{children}</p>
    </div>
  );
}

function requirements(os: Os, backend: Backend): [string, ReactNode][] {
  const linux = os === "linux";
  const pc = linux ? "Ubuntu 24.04 or newer (x64)" : "Windows 10 or 11 (x64)";
  const gpu: Record<Backend, string> = {
    cuda: "NVIDIA RTX 30-series or newer, 4 GB VRAM or more for image jobs. Driver 525.60.13 or newer, 570+ recommended.",
    vulkan: linux
      ? "AMD or Intel GPU, or an integrated GPU, with a Vulkan driver: sudo apt install libvulkan1 mesa-vulkan-drivers"
      : "AMD or Intel GPU, or an integrated GPU (for example a Ryzen laptop's Radeon), with the vendor's current driver.",
    cpu: "None. Any x64 CPU runs the text model.",
  };
  const python =
    backend === "cuda"
      ? linux
        ? "3.10 to 3.13 with venv: sudo apt install python3-venv"
        : "3.10 to 3.13 from python.org, with “Add python.exe to PATH”"
      : "Not needed for this backend.";
  const rows: [string, ReactNode][] = [
    ["PC", pc],
    ["GPU", gpu[backend]],
    ["Node.js", "24 LTS (22.18 or newer works)"],
    ["Python", python],
    ["Disk", backend === "cuda" ? "About 15 GB free" : "About 1.5 GB free"],
    [
      "Wallet",
      <>
        Any wallet on Robinhood Chain that receives <span className="num">{payoutAssetLabel()}</span>. No token, no stake.
      </>,
    ],
  ];
  if (linux) rows.push(["System packages", "libgomp1 and curl (sudo apt install libgomp1 curl). The installer itself needs no sudo."]);
  rows.push([
    "Jobs it will take",
    backend === "cuda"
      ? "Images (Stable Diffusion 1.5) and text (Qwen2.5-1.5B)"
      : "Text only (Qwen2.5-1.5B), paired with nodes on the same backend",
  ]);
  return rows;
}

/** Steps 1 and 2 of the install guide, tabbed by OS and hardware; steps 3 to 6 follow with the same choice. */
export function SetupGuide() {
  const [os, setOs] = useState<Os>("windows");
  const [backend, setBackend] = useState<Backend>("cuda");
  const file = downloads.files[os];
  const flag = backend === "cuda" ? "" : os === "windows" ? ` -Backend ${backend}` : ` --backend ${backend}`;
  const install =
    os === "windows"
      ? `Expand-Archive ${file.file} -DestinationPath .\ncd sparecycle-node\npowershell -ExecutionPolicy Bypass -File install.ps1${flag}`
      : `tar xzf ${file.file} && cd sparecycle-node && bash install.sh${flag}`;
  const verify = os === "windows" ? `Get-FileHash ${file.file}` : `sha256sum ${file.file}`;

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <Segmented label="Operating system" value={os} onChange={setOs} options={(["windows", "linux"] as Os[]).map((o) => [o, OS_LABEL[o]])} />
        <Segmented
          label="Hardware"
          value={backend}
          onChange={setBackend}
          options={(["cuda", "vulkan", "cpu"] as Backend[]).map((b) => [b, BACKEND_LABEL[b]])}
        />
      </div>

      <ol className="rounded-l border border-line px-5 py-8 sm:px-8">
        <InstallStep n={1} title="Check you have everything">
          <div className="grid gap-2 sm:grid-cols-2">
            {requirements(os, backend).map(([k, v]) => (
              <Req key={k} label={k}>
                {v}
              </Req>
            ))}
          </div>
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
              Get Node.js <ExternalLink className="size-3.5" />
            </a>
            {backend === "cuda" && os === "windows" ? (
              <a href="https://www.python.org/downloads/windows/" target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
                Get Python <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </p>
          {backend !== "cuda" ? (
            <p className="text-xs text-faint">
              Measured on a Ryzen 7 5700U laptop, Qwen2.5-1.5B, 128-token answers: about 27 tok/s on the Radeon iGPU with
              Vulkan, about 33 tok/s on the CPU. A measurement on one machine, not a forecast.
            </p>
          ) : null}
        </InstallStep>

        <InstallStep n={2} title="Download and install">
          <a
            href={`/downloads/${file.file}`}
            download
            className="inline-flex h-11 items-center gap-2 rounded-m bg-text px-4 text-sm font-medium text-coal transition-colors hover:bg-white"
          >
            <Download className="size-4" />
            Download node client ({OS_LABEL[os]})
            <span className="num text-xs text-[#555]">{(file.bytes / 1024).toFixed(0)} KB</span>
          </a>
          <p>
            Open a terminal in the folder you downloaded it to and paste this. Everything goes in the{" "}
            <span className="num text-text">sparecycle-node</span> folder.
          </p>
          <CodeBlock label={os === "windows" ? "PowerShell" : "Terminal"} code={install} />
          <p>
            {backend === "cuda"
              ? "It installs the npm packages, a Python environment with PyTorch and diffusers (about 4 GB), llama.cpp's CUDA build and the Qwen2.5-1.5B model (about 1 GB). Stable Diffusion 1.5 downloads on the first image job."
              : `It installs the npm packages, llama.cpp's ${backend === "vulkan" ? "Vulkan" : "CPU"} build and the Qwen2.5-1.5B model (about 1 GB). No Python, no PyTorch.`}{" "}
            At the end it prints <span className="num text-text">Created node key: 0x…</span>: that address is your node. It only
            signs work; never send funds to it.
          </p>
          <details className="group rounded-m border border-line bg-coal">
            <summary className="cursor-pointer px-4 py-2.5 text-sm text-muted hover:text-text">Check the download (SHA-256)</summary>
            <div className="space-y-2 border-t border-line px-4 py-3">
              <p className="num break-all text-xs text-text">{file.sha256}</p>
              <CodeBlock label="Compare with" code={verify} />
              <p className="text-xs text-faint">
                Version {downloads.version}. All checksums: <a href="/downloads/SHA256SUMS.txt" className="link">SHA256SUMS.txt</a>.
                The node client is adapted from MIT-licensed code; see NOTICE inside the archive.
              </p>
            </div>
          </details>
        </InstallStep>

        <NodeSetup os={os} backend={backend} />
      </ol>
    </div>
  );
}
