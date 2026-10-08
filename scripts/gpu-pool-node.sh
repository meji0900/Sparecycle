#!/usr/bin/env bash
# Runs ON a rented Vast.ai GPU instance (Ubuntu 24.04 image, root) to make it a bootstrap pool node:
# installs Node.js and the node client (cuda), and writes ~/pool-start.sh, which starts the node in the background.
# Create the instance with  --onstart-cmd "bash /root/pool-start.sh"  so the node comes back on every start
# (the scheduler starts and stops pool instances on demand, see src/server/gpu-pool.ts).
#
#   1. scp public/downloads/sparecycle-node-linux.tar.gz scripts/gpu-pool-node.sh root@HOST:
#      ssh root@HOST bash gpu-pool-node.sh          -> prints the node key at the end
#   2. locally: node scripts/pool-owners.mjs sign a <nodeKey>   (b for the second instance)
#   3. ssh root@HOST 'cat > ~/pool-node.env' with SPARECYCLE_NETWORK=https://<site>, SPARECYCLE_OWNER=…, SPARECYCLE_OWNER_SIG=…
#      and SPARECYCLE_NO_BUSY_CHECK=1: inside a container nvidia-smi reports host PIDs, so the node would mistake its own
#      image worker for another program and pause forever; a rented instance is dedicated, so the check is not needed.
#      then ssh root@HOST bash pool-start.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_V=v24.22.1

apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils libgomp1 python3 python3-venv libssl3t64 >/dev/null
if ! command -v node >/dev/null || [[ $(node -v) != v24* ]]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_V/SHASUMS256.txt"
  want=$(grep " node-$NODE_V-linux-x64.tar.xz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)
  [[ $(sha256sum "$tmp/node.tar.xz" | cut -d' ' -f1) == "$want" ]] || { echo "Node.js checksum mismatch" >&2; exit 1; }
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
fi

cd ~
if [[ -f sparecycle-node-linux.tar.gz ]]; then
  mkdir -p sparecycle-node && tar xzf sparecycle-node-linux.tar.gz   # keeps bin/, models/, .venv and the key
fi
cd sparecycle-node
bash install.sh
# Load Stable Diffusion once now, so the first job after a start doesn't wait for a 2 GB download.
HF_HOME="$PWD/models/hf" .venv/bin/python -c "
import sys, torch
sys.path.insert(0, 'python')
from diffusers import StableDiffusionPipeline
from image_worker import MODEL, REVISION
StableDiffusionPipeline.from_pretrained(MODEL, revision=REVISION, torch_dtype=torch.float16, variant='fp16')
print('Stable Diffusion 1.5 cached')
"

cat > ~/pool-start.sh <<'EOF'
#!/usr/bin/env bash
# Started by Vast's onstart on every container start: runs the Sparecycle node in the background.
[[ -f ~/pool-node.env ]] || { echo "no ~/pool-node.env yet"; exit 0; }
set -a; source ~/pool-node.env; set +a
cd ~/sparecycle-node
pgrep -f "[s]rc/agent.ts start" >/dev/null && exit 0
nohup node src/agent.ts start --network "$SPARECYCLE_NETWORK" --owner "$SPARECYCLE_OWNER" --owner-sig "$SPARECYCLE_OWNER_SIG" >> ~/node.log 2>&1 < /dev/null &
echo "node started (log: ~/node.log)"
EOF
chmod +x ~/pool-start.sh
echo "POOL NODE READY. Node key: $(node src/agent.ts init | sed -n 's/.*node key: //p')"
