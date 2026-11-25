# 2026-11-25 · cuda · NVIDIA Blackwell (RTX 5060 Ti) and Turing (RTX 2070)

Brief 3.4, priority P1. Rented boxes (throwaway node keys, never linked to a wallet), bench suite 1
(`node-client/src/bench.ts`), node client 0.3.0, compared with `scripts/compare-bench.mjs` against the reference pair
of 2026-11-22 (RTX 3060 + RTX 4060) and against each other, under the live thresholds (`src/server/verify.ts`: image
≤ 12 differing dHash bits of 64, text similarity ≥ 0.9).

**Verdict: images PASS, text FAIL** for both families. Both stay `untested` in `src/server/gpu-allowlist.json`.

## Devices

| Folder | GPU | Compute cap. | VRAM | Driver | Host | Run |
| --- | --- | --- | --- | --- | --- | --- |
| `RTX-5060-Ti-cuda` | NVIDIA GeForce RTX 5060 Ti | 12.0 | 16311 MB | 620.70.06 | linux 6.8.0-149-generic, AMD Ryzen 5 3600 | 2026-11-25 07:46 UTC, image + text, 2 runs |
| `RTX-2070-cuda` | NVIDIA GeForce RTX 2070 | 7.5 | 8192 MB | 580.173.02 | linux 5.15.0-191-generic, Xeon E3-1225 V2 | 2026-11-25 07:20 UTC, image + text, 2 runs |

Software on both (from `bench.json`): node client 0.3.0 (llama.cpp with `-ub 1`, the live setting), Node v24.22.1,
llama.cpp build 12404 (commit cf9a9957d, CUDA build), PyTorch 2.8.0+cu128 (CUDA 12.8, cuDNN 91002), diffusers 0.35.1,
transformers 4.56.1 — the same builds as the reference pair.

`bench.json` files are the originals except that every image item carries a `fingerprint` (the scheduler's 64-bit
dHash) computed from its PNG with `node scripts/bench-fingerprints.mjs`. The PNGs are not committed.

## Commands

On each rented box (`scripts/gpu-bench-remote.sh`, NVIDIA path; Vast containers exposed no Vulkan device, so no
Vulkan run):

```
bash install.sh
node src/agent.ts bench --backend cuda --repeat 2 --out ~/bench/<GPU>-cuda
```

Comparison (from the repo root; `npm run check:bench` re-runs both and compares with the committed summaries):

```
node scripts/compare-bench.mjs bench/results/2026-11-25-cuda-blackwell-turing/RTX-5060-Ti-cuda bench/results/2026-11-25-cuda-blackwell-turing/RTX-2070-cuda bench/results/2026-11-25-cuda-blackwell-turing/../2026-11-22-cuda-ampere-ada/RTX-3060-cuda bench/results/2026-11-25-cuda-blackwell-turing/../2026-11-22-cuda-ampere-ada/RTX-4060-cuda --only image --json bench/results/2026-11-25-cuda-blackwell-turing/summary-image.json
node scripts/compare-bench.mjs bench/results/2026-11-25-cuda-blackwell-turing/RTX-5060-Ti-cuda bench/results/2026-11-25-cuda-blackwell-turing/RTX-2070-cuda bench/results/2026-11-25-cuda-blackwell-turing/../2026-11-22-cuda-ampere-ada/RTX-3060-cuda-ub1 bench/results/2026-11-25-cuda-blackwell-turing/../2026-11-22-cuda-ampere-ada/RTX-4060-cuda-ub1 --only text --json bench/results/2026-11-25-cuda-blackwell-turing/summary-text.json
```

## Results against the pass criteria (brief 3.3)

| # | Criterion | RTX 5060 Ti (Blackwell) | RTX 2070 (Turing) |
| --- | --- | --- | --- |
| 1 | Self-stability (run 2 vs run 1) | images max 0 bits; text min similarity 1.000 | images max 0 bits; text min similarity 1.000 |
| 2a | Images vs RTX 3060 / RTX 4060 | **8/8** and **8/8**, worst 2 and 4 bits | **8/8** and **8/8**, worst 6 and 2 bits |
| 2b | Text vs RTX 3060 / RTX 4060 (`-ub 1`) | **3/10** and **3/10**, lowest similarity 0.418, median 0.764 | **6/10** and **6/10**, lowest similarity 0.408, median 0.925 |
| 3 | Image threshold safety | same job up to 6 bits (all four devices), another seed from 24 bits: 6 bits under the threshold, 11 above | same |
| 4 | Same suite and client settings | suite 1, node client 0.3.0, same builds as the reference | same |

Between themselves: RTX 5060 Ti vs RTX 2070 images 8/8 (worst 6 bits, bicycle), text 2/10 (lowest 0.407, story).
The reference pair still agrees on every text case (10/10, similarity 1.000): the text differences come from these
two architectures, not from the client settings. Every device is self-stable, so each family may agree with itself;
that is untested (one card per family).

Speed (informational): RTX 5060 Ti image median 1.40 s, text 231.8 tok/s; RTX 2070 image median 2.81 s, text
190.9 tok/s.

## Decision

- `nvidia-rtx50-blackwell` and `nvidia-rtx20-turing` stay **untested**: a family is allowed only when both job kinds
  pass, and text does not. Under `GPU_ALLOWLIST_MODE=enforce` they get no jobs; in today's observe mode they can take
  jobs, and a text job they disagree on is simply not paid (and not charged).
- The thresholds are not changed (brief: image 12 bits, text 0.9).
- Open (brief 3.6, Fabio): allow these families for **image jobs only** (needs a per-kind rule in the allowlist), or
  pair text jobs within one family (option B, needs a second card of each family benched against the first).
- The challenge reference (`bench/reference/suite-1-cuda.json`) is unchanged.

## Cost

Vast.ai, 25 Nov 2026: one RTX 2070 at $0.064/h and one RTX 5060 Ti at $0.121/h, under an hour each, plus a first
5060 Ti host that was dropped because its download stalled (~0.4 MB/s). About $0.25 in total.
