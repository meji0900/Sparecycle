#!/usr/bin/env bash
# Runs ON a rented Linux GPU box (Ubuntu 24.04 image, as root) for the GPU agreement test:
# installs Node.js and the system packages the node client needs, installs the node client (cuda, plus vulkan when
# the container exposes a Vulkan GPU), runs `node src/agent.ts bench` for each backend and packs the results.
#
#   scp -P PORT public/downloads/sparecycle-node-linux.tar.gz scripts/gpu-bench-remote.sh root@HOST:
#   ssh -p PORT root@HOST 'nohup bash gpu-bench-remote.sh > bench.log 2>&1 &'
#   ...later: scp -P PORT root@HOST:bench-*.tar.gz .bench/
#
# The box is throwaway: the node key the installer creates there is never linked to a wallet.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_V=v24.22.1

echo "== system packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils libgomp1 python3 python3-venv libssl3t64 libvulkan1 vulkan-tools libxext6 libx11-6 >/dev/null

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
nvidia-smi --query-gpu=name,compute_cap,driver_version,memory.total --format=csv,noheader
gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 | sed 's/NVIDIA //; s/GeForce //' | tr ' ' '-' | tr -cd 'A-Za-z0-9-')
mkdir -p ~/bench

bash install.sh
node src/agent.ts bench --backend cuda --out ~/bench/"$gpu"-cuda

if vulkaninfo --summary 2>/dev/null | grep -Eq "deviceType *= *PHYSICAL_DEVICE_TYPE_(DISCRETE|INTEGRATED)_GPU"; then
  bash install.sh --backend vulkan
  node src/agent.ts bench --backend vulkan --no-image --out ~/bench/"$gpu"-vulkan
else
  echo "No Vulkan GPU visible in this container (needs NVIDIA_DRIVER_CAPABILITIES with graphics): vulkan bench skipped"
fi

tar czf ~/bench-"$gpu".tar.gz -C ~/bench .
echo "BENCH DONE: ~/bench-$gpu.tar.gz"
