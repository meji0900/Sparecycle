# GPU bench results

Published cross-device agreement results (docs/gpu-support.md). Each folder holds every device's `bench.json` (image
fingerprints instead of PNGs), the compare-bench summaries, `runs.json` (how they were made; `npm run check:bench`
re-runs them) and a README with devices, versions, commands and the verdict against the live thresholds
(image ≤ 12 dHash bits, text similarity ≥ 0.9).

| Date | Family | Backend | Suite | Node client | Verdict | Margin | Folder |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-22 | NVIDIA RTX 30 (Ampere, RTX 3060) vs RTX 40 (Ada, RTX 4060) | cuda | 1 | 0.2.0 settings (`-ub 1` for text; version not recorded in bench.json) | **pass** (reference pair) | images 8/8, worst 4 bits (8 below the threshold, other seeds from 24 bits = 11 above); text 10/10 identical (min similarity 1.000) | [2026-11-22-cuda-ampere-ada](2026-11-22-cuda-ampere-ada/README.md) |

Not benched yet (brief 3.4): P1 NVIDIA RTX 50 (Blackwell) and RTX 20 (Turing) on cuda; P2 NVIDIA on Vulkan and AMD
Radeon on Vulkan (text only; together they form the first Vulkan reference); P3 Intel Arc and integrated GPUs.
