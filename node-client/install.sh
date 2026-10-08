#!/usr/bin/env bash
# Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) - see NOTICE.
#
# Sparecycle node installer (Linux x64).
#
#   bash install.sh                      # NVIDIA GPU (Ubuntu 24.04+ / glibc 2.38+): image + text jobs
#   bash install.sh --backend vulkan     # any Vulkan GPU (AMD / Intel / iGPU): text jobs only
#   bash install.sh --backend cpu        # no usable GPU: text jobs only, on the CPU
#
# cuda:        npm packages, a Python venv with PyTorch + diffusers (Stable Diffusion 1.5), llama.cpp's CUDA build and
#              Qwen2.5-1.5B-Instruct GGUF Q4_K_M.
# vulkan, cpu: npm packages, llama.cpp's Vulkan / CPU build and the same GGUF. No Python, no PyTorch.
# Each backend's llama.cpp goes in its own folder (bin/llama-<backend>), so one machine can hold several.
# Same release and model as install.ps1 on Windows. Needs Node.js 22.18+ (24 LTS recommended), curl or wget;
# cuda also needs Python 3.10-3.13 with venv and an NVIDIA driver. No sudo: everything goes in this folder, except the
# node key (~/.sparecycle-node, or SPARECYCLE_KEY_FILE) and the pip / npm caches in your home folder.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

BACKEND=cuda
while [[ $# -gt 0 ]]; do
  case $1 in
    --backend) BACKEND=${2:-}; shift 2 ;;
    --backend=*) BACKEND=${1#*=}; shift ;;
    *) echo "unknown option $1 (use --backend cuda|vulkan|cpu)" >&2; exit 1 ;;
  esac
done
case $BACKEND in cuda | vulkan | cpu) ;; *) echo "--backend must be cuda, vulkan or cpu" >&2; exit 1 ;; esac

# ---- Pinned versions and downloads (edit here) -------------------------------------------------------------
NODE_MIN="22.18.0"
LLAMA_RELEASE="b12404"                                  # llama.cpp release tag (all backends)
LLAMA_API="https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_RELEASE}"
LLAMA_BASE="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}"
# cuda: pinned asset names and SHA-256 (match the GitHub release digests of LLAMA_RELEASE).
CUDA_ASSET="llama-${LLAMA_RELEASE}-bin-ubuntu-cuda-12.8-x64.tar.gz"
CUDA_SHA256="42edd396109b273fa510c69205bb88fa8d912cc118b2b6d2e287c64f4cc8eb7c"
CUDART_ASSET="cudart-llama-${LLAMA_RELEASE}-bin-ubuntu-cuda-12.8-x64.tar.gz"
CUDART_SHA256="0ebfc4b2e66feaf89729e823e7848b9d73b0b71f6ff63ed6cca893779633c13f"
# vulkan / cpu: the asset is resolved from the GitHub release API at LLAMA_RELEASE by this pattern and checked
# against the SHA-256 digest GitHub publishes for it.
VULKAN_PATTERN='^llama-.+-bin-ubuntu-vulkan-x64\.tar\.gz$'
CPU_PATTERN='^llama-.+-bin-ubuntu-x64\.tar\.gz$'
# cuda only: PyTorch + diffusers for Stable Diffusion 1.5
TORCH_VERSION="2.8.0"
TORCH_INDEX="https://download.pytorch.org/whl/cu128"
PY_PACKAGES=("diffusers==0.35.1" "transformers==4.56.1" "accelerate==1.10.1" "safetensors==0.6.2" "pillow==11.3.0")
# Text model: Qwen2.5-1.5B-Instruct (Apache-2.0), official GGUF repo on Hugging Face.
QWEN_REPO="Qwen/Qwen2.5-1.5B-Instruct-GGUF"
QWEN_FILE="qwen2.5-1.5b-instruct-q4_k_m.gguf"
QWEN_URL="https://huggingface.co/${QWEN_REPO}/resolve/main/${QWEN_FILE}"
# SHA-256 = the Hugging Face LFS oid of the file (api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/tree/main), checked 20 Nov 2026.
QWEN_SHA256="6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e"
# Image model (cuda only): Stable Diffusion 1.5 (CreativeML OpenRAIL-M). diffusers downloads it into models/hf on the
# first image job; override with SPARECYCLE_SD15_MODEL.
# -------------------------------------------------------------------------------------------------------------

if [[ -t 1 ]]; then C="\033[36m" R="\033[31m" Y="\033[33m" G="\033[32m" N="\033[0m"; else C="" R="" Y="" G="" N=""; fi
step() { printf "\n${C}== %s${N}\n" "$1"; }
die() { printf "${R}%s${N}\n" "$1" >&2; exit 1; }
warn() { printf "${Y}%s${N}\n" "$1"; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
download() { # url out: resumes a partial download
  if command -v curl >/dev/null; then curl -fL --retry 5 --retry-delay 3 -C - -o "$2" "$1"
  else wget -q --show-progress --tries=5 -c -O "$2" "$1"; fi
}
fetch() { # url out [sha256]
  local url=$1 out=$2 sha=${3:-}
  if [[ -s $out ]] && { [[ -z $sha ]] || [[ $(sha_of "$out") == "$sha" ]]; }; then echo "  have $out"; return; fi
  echo "  downloading $url"
  if ! download "$url" "$out.part"; then
    [[ -n $sha && -s $out.part && $(sha_of "$out.part") == "$sha" ]] || die "Download failed: $url (run install.sh again to resume)."
  fi
  if [[ -n $sha && $(sha_of "$out.part") != "$sha" ]]; then rm -f "$out.part"; die "Checksum mismatch for $out"; fi
  mv -f "$out.part" "$out"
}
# The one asset of LLAMA_RELEASE matching a pattern -> "name url sha256" (node does the JSON; it is required anyway).
resolve_asset() {
  node --input-type=module -e '
    const [api, pattern] = process.argv.slice(1);
    const res = await fetch(api, { headers: { "user-agent": "sparecycle-node-installer", accept: "application/vnd.github+json" } });
    if (!res.ok) { console.error(`GitHub API ${res.status} for ${api}`); process.exit(1); }
    const hits = (await res.json()).assets.filter((a) => new RegExp(pattern).test(a.name));
    if (hits.length !== 1) { console.error(`expected one asset matching ${pattern}, found ${hits.length}`); process.exit(1); }
    const a = hits[0];
    console.log(a.name, a.browser_download_url, (a.digest ?? "").startsWith("sha256:") ? a.digest.slice(7) : "");
  ' "$LLAMA_API" "$1"
}

printf "${C}Sparecycle node installer, backend: %s${N}\n" "$BACKEND"
step "Checking requirements"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die "This installer is for Linux x64. On Windows use install.ps1."
libs=$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p)
grep -q "libgomp.so.1 " <<<"$libs" || die "libgomp1 (OpenMP) is missing, llama.cpp needs it: sudo apt install libgomp1, then run install.sh again."
command -v node >/dev/null || die "Node.js not found. Install Node.js 24 LTS from https://nodejs.org (or: nvm install 24)."
v=$(node -v); v=${v#v}
ver_ge "$v" "$NODE_MIN" || die "Node.js $v is too old, need $NODE_MIN or newer (24 LTS recommended)."
command -v npm >/dev/null || die "npm not found. It comes with Node.js from https://nodejs.org"
command -v curl >/dev/null || command -v wget >/dev/null || die "curl or wget is required (sudo apt install curl)."
if [[ $BACKEND == cuda ]]; then
  # llama.cpp's Linux CUDA build is built on Ubuntu 24.04 and needs its glibc (2.38+) and OpenSSL 3.
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
  ver_ge "${glibc:-0}" 2.38 || die "glibc ${glibc:-unknown} is too old: llama.cpp's CUDA build needs glibc 2.38+ (Ubuntu 24.04 or newer)."
  grep -q "libssl.so.3 " <<<"$libs" || die "OpenSSL 3 is missing, llama.cpp needs it: sudo apt install libssl3t64, then run install.sh again."
  command -v nvidia-smi >/dev/null || die "nvidia-smi not found. The cuda backend needs an NVIDIA GPU with a current driver (no NVIDIA GPU? use --backend vulkan or --backend cpu for text jobs)."
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || die "nvidia-smi can't reach the NVIDIA driver. Reboot after a driver or kernel update, then run install.sh again."
  drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | awk 'NR == 1 {print $1}')
  ver_ge "$drv" 525.60.13 || die "NVIDIA driver $drv is too old for CUDA 12. Update it (Ubuntu: sudo ubuntu-drivers install), reboot, run install.sh again."
  ver_ge "$drv" 570 || warn "  NVIDIA driver $drv: 570 or newer is recommended (CUDA 12.8). If jobs fail, update the driver."
elif [[ $BACKEND == vulkan ]]; then
  grep -q "libvulkan.so.1 " <<<"$libs" || die "The Vulkan loader is missing: sudo apt install libvulkan1 mesa-vulkan-drivers (or your GPU vendor's Vulkan driver), then run install.sh again."
  command -v vulkaninfo >/dev/null && echo "  Vulkan: $(vulkaninfo --summary 2>/dev/null | grep -m1 deviceName | sed 's/^[[:space:]]*//')"
fi
need_gb=$([[ $BACKEND == cuda ]] && echo 15 || echo 2)
free_gb=$(( $(df -Pk . | awk 'NR==2 {print $4}') / 1024 / 1024 ))
(( free_gb >= need_gb )) || warn "  Only ${free_gb} GB free here; the install needs about ${need_gb} GB."
find_python() {
  local c p v
  for c in python3.12 python3.13 python3.11 python3.10 python3 python; do
    p=$(command -v "$c" 2>/dev/null) || continue
    v=$("$p" -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>/dev/null) || continue
    case $v in 3.10 | 3.11 | 3.12 | 3.13) echo "$p"; return 0 ;; esac
  done
  return 1
}
if [[ $BACKEND == cuda ]]; then
  py=$(find_python) || die "Python 3.10-3.13 not found. Ubuntu 22.04/24.04 ship one (python3). On a newer release: sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt install python3.12 python3.12-venv, then run install.sh again."
  pyv=$("$py" -c "import sys; print('%d.%d' % sys.version_info[:2])")
  "$py" -c "import ensurepip, venv" 2>/dev/null || die "Python $pyv can't create a venv. Ubuntu: sudo apt install python$pyv-venv, then run install.sh again."
  echo "  Python: $py ($pyv)"
fi

step "npm packages"
npm install --omit=dev --no-audit --no-fund --no-package-lock || die "npm install failed."

if [[ $BACKEND == cuda ]]; then
  step "Python venv for image jobs (PyTorch CUDA, diffusers)"
  vpy="$PWD/.venv/bin/python"
  if [[ ! -x $vpy ]] || ! "$vpy" -m pip --version >/dev/null 2>&1; then
    rm -rf .venv
    "$py" -m venv .venv || die "Could not create the Python venv."
  fi
  "$vpy" -m pip install --upgrade pip -q || die "pip upgrade failed (run install.sh again)."
  echo "  PyTorch with CUDA is about 4 GB, this takes a while"
  "$vpy" -m pip install "torch==${TORCH_VERSION}" --index-url "$TORCH_INDEX" --resume-retries 20 -q || die "PyTorch install failed (check your internet connection and run install.sh again)."
  "$vpy" -m pip install "${PY_PACKAGES[@]}" --resume-retries 20 -q || die "pip install failed (run install.sh again)."
  "$vpy" -c "import torch; print('  CUDA available:', torch.cuda.is_available())"
else
  step "No Python needed for --backend $BACKEND (text jobs only)"
fi

step "llama.cpp ${LLAMA_RELEASE} (${BACKEND}) for text jobs"
dir="bin/llama-${BACKEND}"
mkdir -p "$dir"
if [[ $BACKEND == cuda ]]; then
  fetch "$LLAMA_BASE/$CUDA_ASSET" "$dir/llama.tar.gz" "$CUDA_SHA256"
  fetch "$LLAMA_BASE/$CUDART_ASSET" "$dir/cudart.tar.gz" "$CUDART_SHA256"
  tar -xzf "$dir/cudart.tar.gz" -C "$dir" --strip-components=1
else
  pattern=$([[ $BACKEND == vulkan ]] && echo "$VULKAN_PATTERN" || echo "$CPU_PATTERN")
  read -r asset url sha < <(resolve_asset "$pattern") || die "Could not resolve the llama.cpp ${LLAMA_RELEASE} asset for ${BACKEND}."
  [[ -n ${sha:-} ]] || warn "  GitHub published no digest for $asset; downloading unverified"
  echo "  asset: $asset"
  fetch "$url" "$dir/llama.tar.gz" "${sha:-}"
fi
tar -xzf "$dir/llama.tar.gz" -C "$dir" --strip-components=1
llv=$(LD_LIBRARY_PATH="$PWD/$dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$dir/llama-server" --version 2>&1) || true
grep -q "version: " <<<"$llv" || die "llama-server doesn't run on this system:
$llv"
grep -E "version: |Vulkan|ggml_vulkan" <<<"$llv" | head -n 4 | sed 's/^/  /'

step "Text model (${QWEN_REPO}, ${QWEN_FILE}, about 1 GB)"
mkdir -p models
fetch "$QWEN_URL" "models/$QWEN_FILE" "$QWEN_SHA256"
if [[ -z $QWEN_SHA256 ]]; then
  warn "  SHA-256 of models/$QWEN_FILE: $(sha_of "models/$QWEN_FILE")"
  warn "  (not pinned yet: compare it with the file page on huggingface.co/${QWEN_REPO}, then pin QWEN_SHA256)"
fi
[[ $BACKEND == cuda ]] && echo "  Stable Diffusion 1.5 downloads into models/hf on the first image job."

step "Node key"
node src/agent.ts init

printf "${G}%s${N}\n" "
Installed (backend $BACKEND). Next, in this folder ($PWD):
  1. node src/agent.ts link-message --owner 0xYOUR_WALLET
     Sign the printed message with that wallet (personal_sign, no gas). That wallet receives payouts.
  2. node src/agent.ts start --network <SCHEDULER_URL> --owner 0xYOUR_WALLET --owner-sig 0xSIGNATURE --backend $BACKEND
     Optional: --hours 1-8,22-24 (local hours to work), --no-image, --no-text.
     Tip: run it inside tmux or screen so the node keeps working after you close the terminal."
