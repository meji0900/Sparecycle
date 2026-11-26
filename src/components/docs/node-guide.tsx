"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CodeBlock } from "@/components/ui/code-block";
import downloads from "@/lib/downloads.json";
import { cn } from "@/lib/utils";
import { C, Defs, Note, Step, Steps } from "./docs-ui";

type Os = "windows" | "linux";
type Backend = "cuda" | "vulkan" | "cpu";

const OS: [Os, string][] = [
  ["windows", "Windows"],
  ["linux", "Linux"],
];
const BACKENDS: [Backend, string][] = [
  ["cuda", "NVIDIA (cuda)"],
  ["vulkan", "AMD / Intel / iGPU (vulkan)"],
  ["cpu", "CPU only (cpu)"],
];

/** Tabs with radio semantics: arrow keys move, the selected tab is the only tab stop. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap gap-1 rounded-l border border-line bg-coal p-1"
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
          className={cn("h-9 rounded-m px-3.5 text-sm transition-colors duration-150", value === v ? "bg-text text-coal" : "text-muted hover:text-text")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function needs(os: Os, backend: Backend): [ReactNode, ReactNode][] {
  const linux = os === "linux";
  const rows: [ReactNode, ReactNode][] = [
    ["Computer", linux ? "Linux x64. For cuda: glibc 2.38 or newer (Ubuntu 24.04 or newer)." : "Windows 10 or 11, x64."],
    [
      "Hardware",
      backend === "cuda"
        ? "An NVIDIA GPU with a current driver. RTX 30 and RTX 40 series are benched and supported; other cards are not benched yet. 4 GB of VRAM for image jobs."
        : backend === "vulkan"
          ? linux
            ? "An AMD or Intel GPU, or an integrated GPU, with a Vulkan driver (sudo apt install libvulkan1 mesa-vulkan-drivers). At least 8 GB of system RAM."
            : "An AMD or Intel GPU, or an integrated GPU, with the vendor's current driver. At least 8 GB of system RAM."
          : "Any x64 CPU. At least 8 GB of RAM.",
    ],
    ["Node.js", "24 LTS (22.18 or newer works)."],
  ];
  if (backend === "cuda") rows.push(["Python", linux ? "3.10 to 3.13 with venv (sudo apt install python3-venv)." : "3.10 to 3.13 from python.org, added to PATH."]);
  if (linux) rows.push(["Packages", "libgomp1 and curl (sudo apt install libgomp1 curl). The installer itself needs no sudo."]);
  rows.push(["Disk", backend === "cuda" ? "About 15 GB free." : "About 1.5 GB free."]);
  rows.push(["Jobs it takes", backend === "cuda" ? "Images (Stable Diffusion 1.5) and text (Qwen2.5-1.5B)." : "Text only (Qwen2.5-1.5B)."]);
  rows.push(["Wallet", "Any wallet on Robinhood Chain to receive payouts. No token and no stake."]);
  return rows;
}

/** Path B of the docs: from download to a node that shows online, per OS and backend. */
export function NodeGuide({ origin }: { origin: string }) {
  const [os, setOs] = useState<Os>("windows");
  const [backend, setBackend] = useState<Backend>("cuda");
  const file = downloads.files[os];
  const win = os === "windows";
  const shell = win ? "PowerShell" : "Terminal (bash)";
  const flag = backend === "cuda" ? "" : win ? ` -Backend ${backend}` : ` --backend ${backend}`;

  const download = win
    ? `Invoke-WebRequest -Uri ${origin}/downloads/${file.file} -OutFile ${file.file}\n(Get-FileHash .\\${file.file} -Algorithm SHA256).Hash -eq "${file.sha256}"`
    : `curl -LO ${origin}/downloads/${file.file}\necho "${file.sha256}  ${file.file}" | sha256sum -c -`;
  const install = win
    ? `Expand-Archive ${file.file} -DestinationPath .\ncd sparecycle-node\npowershell -ExecutionPolicy Bypass -File install.ps1${flag}`
    : `tar xzf ${file.file} && cd sparecycle-node && bash install.sh${flag}`;
  const link = "node src/agent.ts link-message --owner 0xYOUR_WALLET";
  const startParts = [
    "node src/agent.ts start",
    `--network ${origin}`,
    "--owner 0xYOUR_WALLET",
    "--owner-sig 0xSIGNATURE",
    ...(backend === "cuda" ? [] : [`--backend ${backend}`]),
  ];
  const start = startParts.join(win ? " `\n  " : " \\\n  ");
  const check = `${win ? "curl.exe" : "curl"} -s ${origin}/api/v1/nodes`;

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <Choice label="Operating system" value={os} options={OS} onChange={setOs} />
        <Choice label="Hardware" value={backend} options={BACKENDS} onChange={setBackend} />
      </div>

      <div className="mt-8">
        <Steps>
          <Step n={1} title="Check you have everything">
            <Defs items={needs(os, backend)} />
          </Step>

          <Step n={2} title="Download and check the file">
            <p>Open {win ? "PowerShell" : "a terminal"} in an empty folder and paste:</p>
            <CodeBlock label={shell} code={download} />
            <p>
              {win ? (
                <>
                  The second line must print <C>True</C>.
                </>
              ) : (
                <>
                  The second line must print <C>{`${file.file}: OK`}</C>.
                </>
              )}{" "}
              If it does not, delete the file and do not run it. Node client {downloads.version}; all checksums are in{" "}
              <a href="/downloads/SHA256SUMS.txt" className="link">
                SHA256SUMS.txt
              </a>
              .
            </p>
          </Step>

          <Step n={3} title="Install">
            <CodeBlock label={shell} code={install} />
            <p>
              {backend === "cuda"
                ? "It installs the npm packages, a Python environment with PyTorch and diffusers (about 4 GB), llama.cpp's CUDA build and the Qwen2.5-1.5B model (about 1 GB). Stable Diffusion 1.5 downloads on the first image job."
                : `It installs the npm packages, llama.cpp's ${backend === "vulkan" ? "Vulkan" : "CPU"} build and the Qwen2.5-1.5B model (about 1 GB). No Python.`}{" "}
              At the end it prints <C>Created node key: 0x…</C>. That key only signs work; never send funds to it.
            </p>
          </Step>

          <Step n={4} title="Link your wallet (once, no gas)">
            <p>In the same folder, print the message that links this node to your payout wallet:</p>
            <CodeBlock label={shell} code={link} />
            <p>
              Sign the printed line exactly as shown with that wallet (&quot;Sign message&quot;, <C>personal_sign</C>). It reads{" "}
              <C>Sparecycle: link node 0x… to wallet 0x…</C>. The <Link href="/nodes" className="link">install guide</Link> on the
              site can ask your wallet to sign it for you. Signing costs no gas and moves no funds.
            </p>
          </Step>

          <Step n={5} title="Start the node">
            <CodeBlock label={shell} code={start} />
            <p>Useful flags, added to the same command:</p>
            <Defs
              items={[
                [<C key="h">--hours 1-8,22-24</C>, "Only work in these local hours (end exclusive)."],
                [<C key="n">--no-image</C>, "Skip image jobs (or --no-text to skip text jobs)."],
                [<C key="k">--key-file path</C>, "Use another node key file (default ~/.sparecycle-node/key.json)."],
              ]}
            />
            <p>
              <C>Ctrl+C</C> finishes the current job and stops.{" "}
              {win ? "" : "Run it inside tmux or screen (or as a systemd service) so it keeps working after you close the terminal."}
            </p>
            {backend === "cuda" ? (
              <p>
                On cuda the node pauses on its own while another program uses more than 500 MB of VRAM or the GPU is at 83 °C or
                hotter, and resumes when that ends.
              </p>
            ) : (
              <Note title="No busy or heat pause on this backend">
                There is no reliable cross-vendor reading of GPU temperature or other programs&apos; VRAM use, so the automatic
                pause that cuda nodes have is off for vulkan and cpu. Use <C>--hours</C> to keep the node to times you do not need
                the machine, and mind laptop thermals.
              </Note>
            )}
          </Step>

          <Step n={6} title="See it online">
            <p>
              On start it prints <C>registered with … · payouts go to 0x…</C>. Within two minutes your node appears as online on
              the <Link href="/app" className="link">network status page</Link>, listed by your owner wallet. Or ask the scheduler:
            </p>
            <CodeBlock label={shell} code={check} />
            <p>
              Look for your node key with <C>&quot;online&quot;: true</C> and <C>{`"backend": "${backend}"`}</C>. Jobs are paired
              only with a second node on the same backend and with another owner, so a new node can wait for its first job.
            </p>
          </Step>
        </Steps>
      </div>
    </div>
  );
}
