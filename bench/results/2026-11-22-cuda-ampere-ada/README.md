# 2026-11-22 · cuda · NVIDIA Ampere (RTX 3060) vs Ada (RTX 4060)

The CUDA reference pair. Rented boxes (throwaway node keys, never linked to a wallet), bench suite 1
(`node-client/src/bench.ts`), compared with `scripts/compare-bench.mjs` against the live thresholds
(`src/server/verify.ts`: image ≤ 12 differing dHash bits of 64, text similarity ≥ 0.9).

**Verdict: PASS** for both families on cuda (image and text), with one gap noted under criterion 1.

## Devices

| Folder | GPU | Compute cap. | VRAM | Driver | Host | Run |
| --- | --- | --- | --- | --- | --- | --- |
| `RTX-3060-cuda` | NVIDIA GeForce RTX 3060 | 8.6 | 12288 MB | 590.48.01 | linux 6.8.0-138-generic, Xeon E5-2683 v3 | 2026-11-22 04:42 UTC, image + text, 2 runs |
| `RTX-4060-cuda` | NVIDIA GeForce RTX 4060 | 8.9 | 8188 MB | 595.91.07 | linux 5.15.0-191-generic, Xeon E5-2673 v4 | 2026-11-22 04:31 UTC, image + text, 2 runs |
| `RTX-3060-cuda-ub1` | same box as `RTX-3060-cuda` | 8.6 | 12288 MB | 590.48.01 | same | 2026-11-22 05:16 UTC, text only, 1 run, llama.cpp `-ub 1` |
| `RTX-4060-cuda-ub1` | same box as `RTX-4060-cuda` | 8.9 | 8188 MB | 595.91.07 | same | 2026-11-22 05:16 UTC, text only, 1 run, llama.cpp `-ub 1` |

Software on all four (from `bench.json`): Node v24.22.1, llama.cpp build 12404 (commit cf9a9957d, CUDA build),
PyTorch 2.8.0+cu128 (CUDA 12.8, cuDNN 91002), diffusers 0.35.1, transformers 4.56.1.

Which folder counts for what:

- **Images** come from `RTX-*-cuda` (Stable Diffusion runs in PyTorch; the llama.cpp `-ub` setting does not touch it).
- **Text** comes from `RTX-*-cuda-ub1`: llama.cpp with `-ub 1`, the setting node client 0.2.0 ships (and 0.3.0 keeps).
  The text items inside `RTX-*-cuda` ran with the earlier default batching and are **not** the live configuration:
  they agreed on only 5 of 10 cases (lowest similarity 0.338), which is why 0.2.0 switched to `-ub 1`. They are kept
  unchanged as the record of that finding and are excluded with `--only image`.

`bench.json` files are the originals byte for byte, except that every image item carries a `fingerprint` (the
scheduler's 64-bit dHash) computed from its PNG with `node scripts/bench-fingerprints.mjs` (the same code as live
matching). The PNGs are not committed. `bench.json` of these runs has no node-client version field (added in 0.3.0).

## Commands

On each rented box (`scripts/gpu-bench-remote.sh` of that day, NVIDIA path):

```
bash install.sh
node src/agent.ts bench --backend cuda --out ~/bench/<GPU>-cuda          # default --repeat 2
```

The `-ub1` folders are a text-only, single-run follow-up on the same boxes with llama.cpp `-ub 1`; the exact command
line of that experiment is not recorded in `bench.json`.

Comparison (from the repo root; `npm run check:bench` re-runs both and compares with the committed summaries):

```
node scripts/compare-bench.mjs bench/results/2026-11-22-cuda-ampere-ada/RTX-3060-cuda bench/results/2026-11-22-cuda-ampere-ada/RTX-4060-cuda --only image --json bench/results/2026-11-22-cuda-ampere-ada/summary-image.json
node scripts/compare-bench.mjs bench/results/2026-11-22-cuda-ampere-ada/RTX-3060-cuda-ub1 bench/results/2026-11-22-cuda-ampere-ada/RTX-4060-cuda-ub1 --only text --json bench/results/2026-11-22-cuda-ampere-ada/summary-text.json
```

## Results against the pass criteria (brief 3.3)

| # | Criterion | Result | Margin |
| --- | --- | --- | --- |
| 1 | Self-stability (repeat vs run 1) | Images: max **0 bits** on both cards (≤ 12). Text with `-ub 1`: **not measured** (single run). Text with the earlier settings: min similarity 1.000 on both cards. | images: 12 bits of headroom |
| 2 | Cross-device agreement, every case | Images **8/8** agree, bits per case: lighthouse 1, lighthouse-seed2 0, bicycle **4**, ramen 0, village 0, village-seed2 2, cat 0, sunflowers 0. Text (`-ub 1`) **10/10** identical (similarity 1.000 on every case). | images: worst case 4 bits, 8 bits under the threshold; text: lowest similarity 1.000, 0.100 above the threshold |
| 3 | Image threshold safety | compare-bench **OK**: same job up to 4 bits, another seed from 24 bits (RTX 3060 control min 25, RTX 4060 control min 24). | 8 bits below the threshold, 11 above it |
| 4 | Same suite and client settings | Suite 1 on all; same llama.cpp / PyTorch / diffusers builds; text with `-ub 1` on both. | — |
| 5 | Margins recorded | This table and `summary-image.json` / `summary-text.json`. | — |

Speed (informational): RTX 3060 image median 2.59 s, text 196.3 tok/s; RTX 4060 image median 2.06 s, text 182.1 tok/s
(`-ub 1` runs).

## Decision

- `nvidia-rtx30-ampere` and `nvidia-rtx40-ada` are `allowed` in `src/server/gpu-allowlist.json`.
- These four folders are the CUDA challenge reference: `bench/reference/suite-1-cuda.json` (images from the
  `RTX-*-cuda` folders, text from the `-ub1` folders), built with `scripts/build-challenge-reference.mjs`.

## Gaps

- One card per family. The brief asks for at least two distinct cards per family where the budget allows.
- Text self-stability with `-ub 1` was not re-measured (single run). The next rental (P1) should re-run one Ampere and
  one Ada card with node client 0.3.0 and `--repeat 2`, which closes this gap and records the client version.
