# Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) - see NOTICE.
#
# Sparecycle node installer (Windows x64).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1                    # NVIDIA GPU: image + text jobs
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Backend vulkan    # any Vulkan GPU (AMD / Intel / iGPU): text only
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Backend cpu       # no usable GPU: text only, on the CPU
#
# cuda:        npm packages, a Python venv with PyTorch + diffusers (Stable Diffusion 1.5), llama.cpp's CUDA build and
#              Qwen2.5-1.5B-Instruct GGUF Q4_K_M.
# vulkan, cpu: npm packages, llama.cpp's Vulkan / CPU build and the same GGUF. No Python, no PyTorch.
# Each backend's llama.cpp goes in its own folder (bin\llama-<backend>), so one machine can hold several.
# Same release and model as install.sh on Linux. Needs Node.js 22.18+ (24 LTS recommended); cuda also needs
# Python 3.10-3.13 and an NVIDIA driver. Disk: ~15 GB for cuda, ~1.5 GB for vulkan / cpu.
param(
  [ValidateSet("cuda", "vulkan", "cpu")]
  [string]$Backend = "cuda"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location $PSScriptRoot

# ---- Pinned versions and downloads (edit here) -------------------------------------------------------------
$NodeMin       = [version]"22.18.0"
$LlamaRelease  = "b12404"                                   # llama.cpp release tag (all backends)
$LlamaApi      = "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LlamaRelease"
$LlamaBase     = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaRelease"
# cuda: pinned asset names and SHA-256 (match the GitHub release digests of $LlamaRelease).
$CudaAsset     = "llama-$LlamaRelease-bin-win-cuda-12.4-x64.zip"
$CudaSha256    = "0C70A8DC0BE7F836C82827DD4F279A5416D9CA59BBC6BA29EBD90CFF40D86BAD"
$CudartAsset   = "cudart-llama-bin-win-cuda-12.4-x64.zip"
$CudartSha256  = "8C79A9B226DE4B3CACFD1F83D24F962D0773BE79F1E7B75C6AF4DED7E32AE1D6"
# vulkan / cpu: the asset is resolved from the GitHub release API at $LlamaRelease by this pattern, and checked
# against the SHA-256 digest GitHub publishes for it.
$AssetPattern  = @{ vulkan = '^llama-.+-bin-win-vulkan-x64\.zip$'; cpu = '^llama-.+-bin-win-cpu-x64\.zip$' }
# cuda only: PyTorch + diffusers for Stable Diffusion 1.5
$TorchVersion  = "2.8.0"
$TorchIndex    = "https://download.pytorch.org/whl/cu128"
$PyPackages    = @("diffusers==0.35.1", "transformers==4.56.1", "accelerate==1.10.1", "safetensors==0.6.2", "pillow==11.3.0")
# Text model: Qwen2.5-1.5B-Instruct (Apache-2.0), official GGUF repo on Hugging Face.
$QwenRepo      = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
$QwenFile      = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
$QwenUrl       = "https://huggingface.co/$QwenRepo/resolve/main/$QwenFile"
# SHA-256 = the Hugging Face LFS oid of the file (api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/tree/main), checked 20 Nov 2026.
$QwenSha256    = "6A1A2EB6D15622BF3C96857206351BA97E1AF16C30D7A74EE38970E434E9407E"
# Image model (cuda only): Stable Diffusion 1.5 (CreativeML OpenRAIL-M). diffusers downloads it into models\hf on
# the first image job; override with SPARECYCLE_SD15_MODEL.
# -------------------------------------------------------------------------------------------------------------

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Need($ok, $msg) { if (-not $ok) { Write-Host $msg -ForegroundColor Red; exit 1 } }
function Fetch($url, $out, $sha) {
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0) -and (-not $sha -or (Get-FileHash $out -Algorithm SHA256).Hash -eq $sha)) { Write-Host "  have $out"; return }
  Write-Host "  downloading $url"
  Invoke-WebRequest -Uri $url -OutFile "$out.part" -UseBasicParsing
  $got = (Get-FileHash "$out.part" -Algorithm SHA256).Hash
  if ($sha -and $got -ne $sha) { Remove-Item "$out.part"; throw "Checksum mismatch for $out" }
  Move-Item -Force "$out.part" $out
}
# The one asset of $LlamaRelease whose name matches $pattern: name, URL and SHA-256 (from GitHub's digest).
function Resolve-LlamaAsset($pattern) {
  $rel = Invoke-RestMethod -Uri $LlamaApi -Headers @{ "User-Agent" = "sparecycle-node-installer"; "Accept" = "application/vnd.github+json" }
  $hits = @($rel.assets | Where-Object { $_.name -match $pattern })
  Need ($hits.Count -eq 1) "Expected exactly one llama.cpp $LlamaRelease asset matching $pattern, found $($hits.Count)."
  $sha = ""
  if ($hits[0].digest -and $hits[0].digest -like "sha256:*") { $sha = $hits[0].digest.Substring(7).ToUpper() }
  return @{ name = $hits[0].name; url = $hits[0].browser_download_url; sha = $sha }
}

Write-Host "Sparecycle node installer, backend: $Backend" -ForegroundColor Cyan
Step "Checking requirements"
$node = (Get-Command node -ErrorAction SilentlyContinue)
Need $node "Node.js not found. Install Node.js 24 LTS from https://nodejs.org"
$v = [version]((node -v).TrimStart("v"))
Need ($v -ge $NodeMin) "Node.js $v is too old, need $NodeMin or newer (24 LTS recommended)."
if ($Backend -eq "cuda") {
  Need (Get-Command nvidia-smi -ErrorAction SilentlyContinue) "nvidia-smi not found. The cuda backend needs an NVIDIA GPU with a current driver (no NVIDIA GPU? use -Backend vulkan or -Backend cpu for text jobs)."
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
} elseif ($Backend -eq "vulkan") {
  if (Get-Command vulkaninfo -ErrorAction SilentlyContinue) {
    # vulkaninfo prints loader warnings (e.g. a broken overlay layer) on stderr; they are not fatal.
    $ErrorActionPreference = "Continue"
    $dev = (vulkaninfo --summary 2>$null | Select-String "deviceName" | Select-Object -First 1)
    $ErrorActionPreference = "Stop"
    Write-Host "  Vulkan:$("$dev".Trim() -replace '^deviceName\s*=\s*', ' ')"
  } else {
    Write-Host "  vulkaninfo not found: make sure your GPU driver supports Vulkan (llama-server --version below lists the devices it sees)." -ForegroundColor Yellow
  }
}
# A real Python 3.10-3.13 (the "python" in WindowsApps is only a Microsoft Store shortcut). cuda only.
function Find-Python {
  $ErrorActionPreference = "Continue"
  $c = @()
  $c += Get-Command python -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch "WindowsApps" } | ForEach-Object { $_.Source }
  $c += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", "$env:ProgramFiles\Python3*\python.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName }
  foreach ($p in $c) {
    $pv = & $p -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($pv -and [version]$pv -ge [version]"3.10" -and [version]$pv -le [version]"3.13") { return $p }
  }
  $launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($launcher) { foreach ($ver in "3.12", "3.13", "3.11", "3.10") { $p = & py "-$ver" -c "import sys; print(sys.executable)" 2>$null; if ($p) { return $p.Trim() } } }
  return $null
}
if ($Backend -eq "cuda") {
  $py = Find-Python
  Need $py "Python 3.10-3.13 not found. Install Python 3.12 from https://www.python.org (tick 'Add python.exe to PATH'), then run install.ps1 again."
  Write-Host "  Python: $py"
}

Step "npm packages"
npm install --omit=dev --no-audit --no-fund --no-package-lock
Need ($LASTEXITCODE -eq 0) "npm install failed."

if ($Backend -eq "cuda") {
  Step "Python venv for image jobs (PyTorch CUDA, diffusers)"
  $vpy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
  if (-not (Test-Path $vpy)) { & $py -m venv .venv; Need ($LASTEXITCODE -eq 0) "Could not create the Python venv." }
  & $vpy -m pip install --upgrade pip -q
  & $vpy -m pip install "torch==$TorchVersion" --index-url $TorchIndex --resume-retries 20 -q
  Need ($LASTEXITCODE -eq 0) "PyTorch install failed (check your internet connection and run install.ps1 again)."
  & $vpy -m pip install @PyPackages --resume-retries 20 -q
  Need ($LASTEXITCODE -eq 0) "pip install failed (run install.ps1 again)."
  & $vpy -c "import torch; print('  CUDA available:', torch.cuda.is_available())"
} else {
  Step "No Python needed for -Backend $Backend (text jobs only)"
}

Step "llama.cpp $LlamaRelease ($Backend) for text jobs"
$llamaDir = "bin\llama-$Backend"
New-Item -ItemType Directory -Force $llamaDir | Out-Null
if ($Backend -eq "cuda") {
  Fetch "$LlamaBase/$CudaAsset" "$llamaDir\llama.zip" $CudaSha256
  Fetch "$LlamaBase/$CudartAsset" "$llamaDir\cudart.zip" $CudartSha256
  Expand-Archive "$llamaDir\llama.zip" $llamaDir -Force
  Expand-Archive "$llamaDir\cudart.zip" $llamaDir -Force
} else {
  $asset = Resolve-LlamaAsset $AssetPattern[$Backend]
  if (-not $asset.sha) { Write-Host "  GitHub published no digest for $($asset.name); downloading unverified" -ForegroundColor Yellow }
  Write-Host "  asset: $($asset.name)"
  Fetch $asset.url "$llamaDir\llama.zip" $asset.sha
  Expand-Archive "$llamaDir\llama.zip" $llamaDir -Force
}
$server = Join-Path $PSScriptRoot "$llamaDir\llama-server.exe"
Need (Test-Path $server) "llama-server.exe not found in $llamaDir after extracting."
$ErrorActionPreference = "Continue"
$llv = (& $server --version 2>&1 | ForEach-Object { "$_" })
$ErrorActionPreference = "Stop"
Need (($llv -join "`n") -match "version: ") "llama-server doesn't run on this system:`n$($llv -join "`n")"
$llv | Where-Object { $_ -match "version: |Vulkan|ggml_vulkan" } | Select-Object -First 4 | ForEach-Object { Write-Host "  $_" }

Step "Text model ($QwenRepo, $QwenFile, about 1 GB)"
New-Item -ItemType Directory -Force models | Out-Null
Fetch $QwenUrl "models\$QwenFile" $QwenSha256
if (-not $QwenSha256) {
  Write-Host "  SHA-256 of models\$QwenFile`: $((Get-FileHash "models\$QwenFile" -Algorithm SHA256).Hash)" -ForegroundColor Yellow
  Write-Host "  (not pinned yet: compare it with the file page on huggingface.co/$QwenRepo, then pin `$QwenSha256)" -ForegroundColor Yellow
}
if ($Backend -eq "cuda") { Write-Host "  Stable Diffusion 1.5 downloads into models\hf on the first image job." }

Step "Node key"
node src/agent.ts init

Write-Host @"

Installed (backend $Backend). Next, in this folder ($PSScriptRoot):
  1. node src/agent.ts link-message --owner 0xYOUR_WALLET
     Sign the printed message with that wallet (personal_sign, no gas). That wallet receives payouts.
  2. node src/agent.ts start --network <SCHEDULER_URL> --owner 0xYOUR_WALLET --owner-sig 0xSIGNATURE --backend $Backend
     Optional: --hours 1-8,22-24 (local hours to work), --no-image, --no-text.
"@ -ForegroundColor Green
