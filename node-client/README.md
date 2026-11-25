# Sparecycle node

The node client runs the network's two checked AI jobs on an idle GPU (or CPU, for text):

| Model | Kind | Runtime | License | Backends | VRAM needed |
| --- | --- | --- | --- | --- | --- |
| Stable Diffusion 1.5 (`sd15`) | image, 256–512 px, 10–30 steps | Python + PyTorch + diffusers, safety checker on | CreativeML OpenRAIL-M | `cuda` | 4 GB |
| Qwen2.5-1.5B-Instruct GGUF Q4_K_M (`qwen2.5-1.5b`) | text, 16–512 tokens, greedy | llama.cpp `llama-server` | Apache-2.0 | `cuda`, `vulkan`, `cpu` | 2 GB |

Every job runs on **two** nodes with different owner wallets, different GPUs and the **same backend**. When both
results agree (image fingerprint / text similarity), the job counts for the epoch; if they disagree it is not paid.
Each epoch the scheduler splits the reward contract's pot — trading fees that actually arrived, nothing else — pro
rata by work units the scheduler computes from the job spec. There is no promised rate; an epoch with an empty pot
pays nothing. Payouts are claimed on-chain with a Merkle proof on the Sparecycle claim page.

The scheduler is centralized in this MVP: it assigns jobs, compares results and posts each epoch's Merkle root.

## Backends

| `--backend` | Hardware | Jobs | Installer |
| --- | --- | --- | --- |
| `cuda` (default) | NVIDIA GPU, `nvidia-smi` | image + text | `install.ps1` / `install.sh` |
| `vulkan` | any GPU with a Vulkan driver: AMD, Intel, integrated GPUs | text only | `-Backend vulkan` / `--backend vulkan` |
| `cpu` | no usable GPU | text only | `-Backend cpu` / `--backend cpu` |

**Pairing is like-for-like.** CUDA, Vulkan and CPU kernels round floating point differently, so the same greedy
prompt gives different text on different backends. The scheduler only pairs a job's two copies on the same backend,
and only hands out a job's first copy when a second node with that backend is online.

Measured on an AMD Ryzen 7 5700U laptop (Radeon Vega iGPU, AMD driver, Vulkan 1.3.260, 15.4 GB RAM), llama.cpp b12404,
Qwen2.5-1.5B Q4_K_M, 128-token answers, 20 Nov 2026 (`node scripts/e2e-backends.mjs`):

| Setup | Generation speed | Time per 128-token job |
| --- | --- | --- |
| Vulkan, one node alone on the iGPU | ~27 tok/s | ~5 s |
| Vulkan, two nodes sharing the iGPU | ~13 tok/s each | ~10 s |
| CPU (8 cores) | ~33 tok/s | ~4 s |

Two Vulkan nodes agreed on 6 of 6 jobs with byte-identical text. The same 6 prompts on Vulkan vs CPU: 0 of 6
identical, median similarity 0.65 (only 1 of 6 above the 0.9 the scheduler needs). This is why backends are never
mixed. On this laptop the CPU build is faster than the iGPU for this small model. A measurement, not a forecast.

iGPU caveats:
- Integrated GPUs and CPUs use system RAM, shared with everything else. Non-CUDA nodes therefore report a
  conservative quarter of system RAM, capped at 4096 MB, as their "VRAM" (the text model needs about 2 GB with a 4k
  context). Machines with less than 8 GB of RAM don't qualify for text jobs.
- There is no reliable cross-vendor reading of GPU temperature or other programs' VRAM use, so the busy/hot pause
  that CUDA nodes have is **off** for `vulkan` and `cpu`. The node says so at start. Use `--hours` to keep it to times
  when you don't need the machine, and mind laptop thermals.
- Several backends can live on one machine (`bin/llama-cuda`, `bin/llama-vulkan`, `bin/llama-cpu`), but each running
  node needs its own owner wallet and GPU to be paired; one wallet's nodes are never paired with each other.

## Supported GPUs

A GPU family is supported once a published bench shows it matches the reference devices of its backend under the
scheduler's live thresholds. Full list, statuses and evidence: [docs/gpu-support.md](../docs/gpu-support.md) in the
Sparecycle repo (rules: `src/server/gpu-allowlist.json`).

| Family | Backend | Status |
| --- | --- | --- |
| NVIDIA GeForce RTX 30 series (Ampere) | `cuda` | supported (benched 22 Nov 2026) |
| NVIDIA GeForce RTX 40 series (Ada) | `cuda` | supported (benched 22 Nov 2026) |
| NVIDIA GeForce RTX 50 (Blackwell) and RTX 20 (Turing) series | `cuda` | not benched yet |
| Other NVIDIA cards (workstation, datacenter, GTX) | `cuda` | not benched |
| AMD, Intel, integrated GPUs and NVIDIA cards on Vulkan | `vulkan` | not benched (no Vulkan reference yet) |
| CPU | `cpu` | not benched |
| Software rasterizers (llvmpipe, lavapipe, SwiftShader, Microsoft Basic Render) | any | not supported |

When the scheduler enforces the list, a not-benched family still registers but gets no paid jobs, and a software
rasterizer is refused (`gpu-not-supported`, with a link to the list). The node prints its family at start.

Node client 0.3.0 and later also send structured device info at registration (CUDA compute capability and driver, or
the Vulkan vendor / device type / driver) and take part in the scheduler's periodic **GPU challenge**: now and then the
poll hands the node one fixed case of the bench suite instead of a job; the node runs it like a job and the scheduler
compares the answer with the published reference outputs. Challenges are unpaid and never count as jobs. A node that
keeps failing them stops getting jobs. 0.3.0 runs the models with exactly the same settings as 0.2.0, so the two
versions pair normally; 0.2.0 nodes are never sent a challenge.

## Requirements

- Node.js 24 LTS (22.18 or newer works)
- `cuda`: NVIDIA GPU with a current driver (RTX 30 or 40 series: see Supported GPUs), Python 3.10–3.13 (with `venv` on
  Linux), ~15 GB free disk; on Linux glibc 2.38+ (Ubuntu 24.04+)
- `vulkan`: a Vulkan driver (Linux: `libvulkan1` plus the vendor or Mesa driver), ~1.5 GB free disk
- `cpu`: ~1.5 GB free disk
- Linux x64 or Windows 10/11 x64

## Install

From this `node-client` folder:

```bash
# Linux
bash install.sh                      # cuda
bash install.sh --backend vulkan     # AMD / Intel / iGPU
bash install.sh --backend cpu
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File install.ps1                    # cuda
powershell -ExecutionPolicy Bypass -File install.ps1 -Backend vulkan    # AMD / Intel / iGPU
powershell -ExecutionPolicy Bypass -File install.ps1 -Backend cpu
```

The installer puts everything in this folder (`bin/llama-<backend>/`, `models/`, and for cuda `.venv/`), installs
the npm packages and creates your node key in `~/.sparecycle-node/key.json` (or `SPARECYCLE_KEY_FILE`). The
llama.cpp release tag, the model URL and every checksum are variables at the top of each installer. The CUDA assets
are pinned by name and SHA-256. The Vulkan / CPU asset is looked up by name pattern in the GitHub release API at the
pinned tag and checked against the SHA-256 digest GitHub publishes. The Qwen GGUF is pinned to the SHA-256 that
Hugging Face lists for the file.

## Link your wallet (once, no gas)

The node key only signs scheduler requests and job receipts. Your **owner wallet** is the account in the payout
Merkle tree; the node never needs its private key.

```bash
node src/agent.ts link-message --owner 0xYOUR_WALLET
```

Sign the printed message exactly as shown with that wallet (`personal_sign` / "Sign message"). It looks like:

```
Sparecycle: link node 0x<node key, lowercase> to wallet 0x<your wallet, lowercase>
```

## Start

```bash
node src/agent.ts start --network <SCHEDULER_URL> --owner 0xYOUR_WALLET --owner-sig 0xSIGNATURE [--backend vulkan]
```

`<SCHEDULER_URL>` is the Sparecycle site (the client calls `<SCHEDULER_URL>/api/v1/...`).

Options:

| Flag | Effect |
| --- | --- |
| `--backend cuda\|vulkan\|cpu` | how to run the models (default `cuda`; `vulkan` / `cpu` = text jobs only) |
| `--hours 1-8,22-24` | only work during these local hours (end exclusive) |
| `--no-image` / `--no-text` | don't take image / text jobs |
| `--key-file <path>` | use another node key file (default `~/.sparecycle-node/key.json`) |
| `--dev-runner` | local tests only, see below |

On `cuda` the node is a polite guest: it pauses while another program uses more than 500 MB of VRAM or the GPU is at
83 °C or hotter, and resumes on its own (not available on `vulkan` / `cpu`, see above). `Ctrl+C` finishes the current
job and stops; a second `Ctrl+C` quits at once. On Linux run it inside `tmux` or `screen` (or as a systemd service)
so it survives closing the terminal.

Check that the scheduler sees you: your node key appears in `GET <SCHEDULER_URL>/api/v1/nodes` with
`"online": true` and your `backend`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPARECYCLE_KEY_FILE` | `~/.sparecycle-node/key.json` | node key file (`--key-file` wins) |
| `SPARECYCLE_PYTHON` | `.venv` python | Python for the image worker (cuda) |
| `SPARECYCLE_LLAMA_SERVER` | `bin/llama-<backend>/llama-server` | llama.cpp server binary |
| `SPARECYCLE_MODELS_DIR` | `models/` | GGUF location; `HF_HOME` defaults to `models/hf` |
| `SPARECYCLE_SD15_MODEL` | `stable-diffusion-v1-5/stable-diffusion-v1-5` | diffusers model id for SD 1.5 |
| `SPARECYCLE_NO_BUSY_CHECK` | unset | `1` disables the VRAM / temperature pause (cuda) |
| `SPARECYCLE_GPU_UUID` | `nvidia-smi` UUID (cuda), else sha256(hostname, CPU, device, backend) | overrides the device id (local testing only) |
| `SPARECYCLE_VRAM_MB` | `8192` | dev runner only: reported VRAM |

## Dev runner (local tests only)

`--dev-runner` needs no GPU and no models: it returns deterministic synthetic outputs (a PNG rendered from the
seed, text derived from the prompt hash) flagged `dev: true`. It exists so `npm run e2e:local` in the main repo can
prove the full money path on a local chain. A real scheduler refuses dev nodes (`dev-runner-not-accepted`), dev
nodes are only ever paired with dev nodes, and dev results are **never paid** on a real network.

```bash
SPARECYCLE_GPU_UUID=TEST-GPU-A node src/agent.ts start --network http://127.0.0.1:3000 \
  --owner 0xYOUR_TEST_WALLET --owner-sig 0x… --dev-runner --key-file ./test-key.json
```

## Files

- `src/agent.ts` — CLI (`init`, `link-message`, `start`)
- `src/protocol.ts` — wire protocol, byte-identical copy of the site's `src/lib/protocol.ts`
- `src/runners.ts` — SD 1.5 worker and llama-server management (one llama.cpp folder per backend)
- `src/gpu.ts` — device probe per backend (`nvidia-smi` / `vulkaninfo` / CPU), pause rules, `--hours`
- `src/dev-runner.ts` — synthetic outputs for local tests
- `python/image_worker.py` — the Stable Diffusion 1.5 worker

Portions are derived from an MIT-licensed project; see `NOTICE` in the repository root.
