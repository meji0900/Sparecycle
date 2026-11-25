# GPU support

Sparecycle pays for a job only when two nodes on different GPUs return matching results. A GPU family is
**supported** once a published bench shows that it matches the reference devices of its backend under the **live**
thresholds of the scheduler (`src/server/verify.ts`: images agree when at most 12 of 64 dHash bits differ, text agrees
at edit-distance similarity 0.9 or more). Families that have not been benched are not refused, but they do not get
paid jobs once the allowlist is enforced.

## Supported families

| Family | Backend | Status | Evidence |
| --- | --- | --- | --- |
| NVIDIA GeForce RTX 30 series (Ampere, compute capability 8.6) | cuda | **allowed** | [2026-11-22 cuda Ampere / Ada](../bench/results/2026-11-22-cuda-ampere-ada/README.md) |
| NVIDIA GeForce RTX 40 series (Ada, compute capability 8.9) | cuda | **allowed** | [2026-11-22 cuda Ampere / Ada](../bench/results/2026-11-22-cuda-ampere-ada/README.md) |
| NVIDIA GeForce RTX 50 series (Blackwell, consumer) | cuda | untested | not benched yet |
| NVIDIA GeForce RTX 20 series (Turing) | cuda | untested | not benched yet |
| Any other CUDA device (workstation, datacenter, GTX, unknown names) | cuda | untested | not benched |
| Any Vulkan device (AMD, Intel, NVIDIA on Vulkan, integrated GPUs) | vulkan | untested | no Vulkan reference exists yet |
| CPU (llama.cpp on the CPU) | cpu | untested | not benched |
| Software rasterizers (llvmpipe, lavapipe, SwiftShader, Microsoft Basic Render, any Vulkan CPU device) | any | **blocked** | not a GPU |

The rules live in [`src/server/gpu-allowlist.json`](../src/server/gpu-allowlist.json); every published result is
listed in [`bench/results/INDEX.md`](../bench/results/INDEX.md).

## Statuses

| Allowlist status | Stored `gpu_status` | `GPU_ALLOWLIST_MODE=observe` (default) | `GPU_ALLOWLIST_MODE=enforce` |
| --- | --- | --- | --- |
| `allowed` | `eligible` | registers, gets jobs | registers, gets jobs (unless the challenge says otherwise) |
| `untested` | `untested` | registers, gets jobs | registers, gets **no** jobs; it can still take challenges, so data is gathered |
| `blocked` | `blocked` | registers, gets jobs | registration refused: `403 {"error":"gpu-not-supported","supported":"<this page>"}` |

In observe mode the scheduler classifies every registration, logs one line
(`[sparecycle] gpu-allowlist observe: node 0x… "NVIDIA GeForce RTX 3060" cuda cc8.6 -> nvidia-rtx30-ampere (allowed, …)`)
and stores the family and status on the node, but blocks nothing. Nodes that registered before the allowlist existed
are classified from their stored name at their next poll. The public node list (`GET /api/v1/nodes`) shows
`gpuFamily`, `gpuStatus` and `challengeState`; `GET /api/v1/status` shows the modes under `gpuGate`.

Enforcement covers both sides of a job: a node that is not eligible never gets a job task, and it is not counted as the
"compatible peer online" that lets another node take the first task of a job, so jobs are never stranded waiting for
a node that may not take them.

## How classification works

`classifyDevice(backend, gpu name, device info)` in `src/server/gpu-allowlist.ts` tries the rules in order; the first
match wins, otherwise the backend's fallback applies (`cuda-other`, `vulkan-other`, `cpu`, all `untested`). A rule can
check:

- `backends`: `cuda`, `vulkan`, `cpu` or `*`;
- `name`: a case-insensitive regular expression tried on the reported GPU name (from `nvidia-smi` / `vulkaninfo` /
  the CPU model) and on the structured Vulkan `deviceName`;
- `vulkanDeviceType`: e.g. `PHYSICAL_DEVICE_TYPE_CPU`;
- `computeCap`: when the node reports a CUDA compute capability, it must be one of these (an "RTX 3060" reporting 7.5
  falls through to `cuda-other`, untested).

Node client 0.3.0 and later send structured device info at registration (`device`: vendor, CUDA compute capability
and driver from `nvidia-smi`, or the Vulkan vendorID / deviceID / deviceType / deviceName / driver of the device the
node uses). Older clients send only the free-text name, which is still classified. **Everything a node reports about
its hardware can be faked**; the allowlist is a filter, and the periodic challenge below is the check of what the
device actually computes. Dev-runner nodes (no GPU, accepted only with `SCHEDULER_ALLOW_DEV_RUNNER=1` in local tests)
are their own `dev-runner` family.

## Periodic challenge

A challenge is one fixed case of the bench suite (`BENCH_SUITE` in `node-client/src/bench.ts`: the same prompts,
seeds and settings as the published bench) handed to a node through its normal poll. The node runs it like a job
and returns a signed answer (EIP-712 type `ChallengeResult`, distinct from job receipts) to
`POST /api/v1/challenges/:id/result`. The scheduler fingerprints the answer with the live code and compares it with
**every** reference fingerprint of the case in `bench/reference/suite-<BENCH_SUITE>-<backend>.json`, using
`fingerprintsMatch` and the live thresholds (no separate thresholds exist). CUDA nodes with the image model get image
or text cases; text-only nodes get text cases.

Challenges are unpaid, never charged, never counted as jobs, never in a payout tree and never in job lists: they live
in their own `challenges` table.

Who is challenged: only nodes that advertise the `challenge-1` feature at registration (node client 0.3.0+), on a
backend that has a reference. Today only `cuda` has one (`bench/reference/suite-1-cuda.json`); Vulkan and CPU nodes
are never challenged and are gated by the allowlist alone. Project pool nodes (`PROJECT_NODE_OWNERS`) are not exempt.

`CHALLENGE_MODE`:

- `off` (default): no challenges.
- `observe`: challenges are issued (on registration, then every `CHALLENGE_INTERVAL_HOURS` after a pass, or after
  `CHALLENGE_COOLDOWN_HOURS` after a fail) and recorded with their distances, but a node's challenge state and job
  eligibility never change. Use it to check the references against the live pool before enforcing.
- `enforce`: the state machine below gates job leases.

```
register (feature + reference) -> pending-challenge   no jobs, challenges only
pending-challenge --pass--> eligible                   jobs; re-challenged every CHALLENGE_INTERVAL_HOURS (24)
any state --fail (1st)--> cooldown                     no jobs for CHALLENGE_COOLDOWN_HOURS (6), then re-challenged
cooldown --pass--> eligible (strike cleared)
cooldown --fail (2nd in a row)--> suspended            no jobs, no challenges; admin re-qualify only
```

A due challenge is handed out before any new job task. An unanswered challenge expires with the normal lease time
and a new one is issued at the next poll; it does not count as a fail. A cooldown or suspension sticks to the node
key even if the node re-registers without the feature, and a new node key registering the GPU UUID of a suspended node
starts suspended.

### Old node clients (0.2.0) and the challenge

Node client 0.2.0 does not know challenges and never advertises the feature, so it is **never sent one** in any
mode (a challenge payload would be misread as a job). With `CHALLENGE_MODE=enforce` such a node is gated exactly as
before the challenge existed: it gets jobs if the allowlist allows its family. The challenge therefore only gates nodes
that upgraded. Once the live pool runs 0.3.0, a later change can require the feature (not built yet).

### Operator escape hatch

`/api/v1/admin/challenges`, `Authorization: Bearer $SCHEDULER_ADMIN_TOKEN`:

- `GET ?nodeKey=0x…`: the node's family, status, challenge state, last 20 challenges (with distances) and the audit
  log.
- `POST {"nodeKey":"0x…","action":"reissue","note":"…"}`: back to `pending-challenge`, challenged at the next poll.
  A node coming back from suspension keeps one strike: one more fail suspends it again.
- `POST {"nodeKey":"0x…","action":"allow","hours":24,"note":"…"}`: waives the challenge gate until then (max 168 h).
  The allowlist still applies.
- `POST {"nodeKey":"0x…","action":"revoke-allow"}`: ends an allow.

Every POST writes a `gpu_admin_log` row (time, action, node, state before / after, note). The endpoint never assigns,
changes or deletes jobs, tasks or results.

## Flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `GPU_ALLOWLIST_MODE` | `observe` | `observe` = classify, log, store, block nothing; `enforce` = blocked families refused, untested families get no jobs |
| `CHALLENGE_MODE` | `off` | `off` / `observe` / `enforce` (see above) |
| `CHALLENGE_INTERVAL_HOURS` | `24` | Time between challenges of a node that passed (fractions allowed) |
| `CHALLENGE_COOLDOWN_HOURS` | `6` | Time a node waits after a failed challenge (fractions allowed) |

Rollback: set the flag back to `observe` / `off`. The migration only adds columns and tables, so nothing needs to be
undone in the database; challenge states are advisory while the flag is off.

## Adding a family after a bench

1. Run the bench on at least two cards of the family where possible (`scripts/gpu-bench-remote.sh` on a rented box:
   NVIDIA boxes run the cuda bench, Vulkan-only boxes the vulkan text bench, both with `--repeat 2`). Every device of a
   comparison must run the same node client version and `BENCH_SUITE`.
2. Copy each device's folder to `bench/results/<YYYY-MM-DD>-<backend>-<family>/<device>/`. Add image fingerprints and
   drop the PNGs: `node scripts/bench-fingerprints.mjs <folder>` (computed with the live dHash code, never typed in).
3. Compare against the reference devices of the same backend:
   `node scripts/compare-bench.mjs <reference folders> <candidate folders> --json bench/results/<folder>/summary.json`
   (add `--only image|text` when a folder holds a kind that ran with other settings). Record the command in the
   folder's `runs.json`, so `npm run check:bench` re-runs it.
4. Pass criteria (all required): self-stability (repeat max image bits ≤ 12, repeat min text similarity ≥ 0.9);
   every image case ≤ 12 bits and every text case ≥ 0.9 against every reference device (one miss = fail);
   compare-bench prints `OK` for the image threshold (same-job max ≤ 12 and other-seed min > 12); same suite and client
   version on all devices. Write the margins, not just pass / fail, into the folder's `README.md` and a row in
   `bench/results/INDEX.md`.
5. Pass: add a rule to `src/server/gpu-allowlist.json` with `"status": "allowed"` and `"evidence"` pointing at the
   folder (`npm run check:bench` fails if an allowed rule has no evidence). Fail: keep it `untested`, or `blocked` if
   it must not register at all.
6. To make a new backend challengeable, build its reference from passing folders of two devices of different vendors:
   `node scripts/build-challenge-reference.mjs --backend vulkan --out bench/reference/suite-1-vulkan.json <folders>`,
   then load it in `REFERENCES` in `src/server/challenge.ts`. Re-run `npm test` and `npm run check:bench`.
7. Update the setup guide (`src/components/dapp/setup-guide.tsx`), `node-client/README.md` and this page.
