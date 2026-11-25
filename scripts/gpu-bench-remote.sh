#!/usr/bin/env bash
# Runs ON a rented Linux GPU box (Ubuntu 24.04 image, as root) for the GPU agreement test (docs/gpu-support.md):
# installs Node.js and the system packages the node client needs, installs the node client, runs
# `node src/agent.ts bench --repeat 2` for each backend the box can run and packs the results.
#
#   NVIDIA box (nvidia-smi present): cuda bench (image + text), plus a vulkan text bench when the container exposes
#     a Vulkan GPU (Vast containers usually do not: needs NVIDIA_DRIVER_CAPABILITIES with graphics).
#   Vulkan-only box (AMD / Intel, no nvidia-smi): vulkan text bench only (Stable Diffusion 1.5 runs on CUDA only).
#
#   scp -P PORT public/downloads/sparecycle-node-linux.tar.gz scripts/gpu-bench-remote.sh root@HOST:
#   ssh -p PORT root@HOST 'nohup bash gpu-bench-remote.sh > bench.log 2>&1 &'
#   ...later: scp -P PORT root@HOST:bench-*.tar.gz .bench/
#
# The box is throwaway: the node key the installer creates there is never linked to a wallet, and the bench sends
# nothing anywhere. Output folders are named after the device: nvidia-smi name (cuda) or vulkaninfo deviceName.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_V=v24.22.1
REPEAT=2

echo "== system packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils libgomp1 python3 python3-venv libssl3t64 libvulkan1 vulkan-tools mesa-vulkan-drivers libxext6 libx11-6 >/dev/null

if ! command -v node >/dev/null || [[ $(node -v) != v24* ]]; then
  echo "== Node.js $NODE_V"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_V/SHASUMS256.txt"
  want=$(grep " node-$NODE_V-linux-x64.tar.xz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)
  [[ $(sha256sum "$tmp/node.tar.xz" | cut -d' ' -f1) == "$want" ]] || { echo "Node.js checksum mismatch" >&2; exit 1; }
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
fi
node -v

echo "== node client"
cd ~
rm -rf sparecycle-node
tar xzf sparecycle-node-linux.tar.gz
cd sparecycle-node
mkdir -p ~/bench

# Folder-safe device name: "NVIDIA GeForce RTX 3060" -> RTX-3060, "AMD Radeon RX 7600 (RADV NAVI33)" -> AMD-Radeon-RX-7600-RADV-NAVI33
slug() { sed 's/NVIDIA //; s/GeForce //; s/(TM)//g; s/(R)//g' | tr ' ' '-' | tr -cd 'A-Za-z0-9-' | sed 's/--*/-/g; s/^-//; s/-$//'; }

# deviceName of the first non-CPU Vulkan device (the one the node client uses); empty if there is none.
vulkan_device() {
  { vulkaninfo --summary 2>/dev/null || true; } | tr -d '\r' | awk '
    function done_block() { if (name != "" && type != "PHYSICAL_DEVICE_TYPE_CPU" && !found) { print name; found = 1 } }
    /^GPU[0-9]+:/ { done_block(); name = ""; type = "" }
    /^[[:space:]]*deviceType[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); type = $0 }
    /^[[:space:]]*deviceName[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); name = $0 }
    END { done_block() }'
}

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  echo "== NVIDIA GPU: cuda bench (image + text)"
  nvidia-smi --query-gpu=name,compute_cap,driver_version,memory.total --format=csv,noheader
  gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 | slug)
  bash install.sh
  node src/agent.ts bench --backend cuda --repeat "$REPEAT" --out ~/bench/"$gpu"-cuda

  if [[ -n "$(vulkan_device)" ]]; then
    echo "== Vulkan device visible too ($(vulkan_device)): vulkan text bench"
    bash install.sh --backend vulkan
    node src/agent.ts bench --backend vulkan --no-image --repeat "$REPEAT" --out ~/bench/"$gpu"-vulkan
  else
    echo "No Vulkan GPU visible in this container (needs NVIDIA_DRIVER_CAPABILITIES with graphics): vulkan bench skipped"
  fi
else
  echo "== no NVIDIA GPU (nvidia-smi missing or failing): Vulkan-only box, text jobs"
  vk=$(vulkan_device)
  if [[ -z "$vk" ]]; then
    echo "No Vulkan GPU found (vulkaninfo lists no non-CPU device): nothing to bench" >&2
    { vulkaninfo --summary 2>&1 || true; } | tail -n 30 >&2
    exit 1
  fi
  echo "Vulkan device: $vk"
  gpu=$(printf '%s\n' "$vk" | slug)
  bash install.sh --backend vulkan
  node src/agent.ts bench --backend vulkan --no-image --repeat "$REPEAT" --out ~/bench/"$gpu"-vulkan
fi

tar czf ~/bench-"$gpu".tar.gz -C ~/bench .
echo "BENCH DONE: ~/bench-$gpu.tar.gz"
