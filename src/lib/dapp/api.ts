// Client-side access to the scheduler API (docs/SPEC.md, "Scheduler API"). Every call returns either the data
// or a typed failure, so pages can say exactly what went wrong instead of inventing rows.
import { config } from "@/lib/config";
import type { SchedulerStatus } from "@/lib/use-live";

export const apiUrl = (path: string) => `${config.schedulerApiUrl.replace(/\/+$/, "")}${path}`;

export type EpochStatus = "open" | "closed-unposted" | "posted";

export type ApiEpoch = {
  id: number;
  startedAt: number;
  endedAt: number | null;
  root: string | null;
  reserved: string;
  potAtClose: string | null;
  leaves: number;
  postedTx: string | null;
  status: EpochStatus;
  clock?: "contract" | "scheduler-local";
  agreedJobs?: number;
  postError?: string | null;
};
export type EpochsResponse = { epochs: ApiEpoch[] };

export type JobStatus = "queued" | "running" | "checking" | "agreed" | "disagreed" | "expired" | "rejected";

export type ApiJob = {
  id: string;
  model: string;
  kind: "image" | "text";
  status: JobStatus;
  createdAt: number;
  settledAt: number | null;
  promptHash: string;
  workUnits?: number;
  epochId?: number | null;
  eligible?: boolean;
  paid?: boolean;
  /** Who paid: free trial, a customer's balance, or the team's own test job. Absent on older schedulers. */
  payment?: "free" | "paid" | "team";
  /** Quoted price of a paid or team job, wei (decimal string). */
  priceWei?: string | null;
  chargeStatus?: "pending" | "charged" | "released" | "unpaid" | null;
};
export type JobsResponse = { jobs: ApiJob[] };

/** GET /api/v1/payments/account?address= — wei amounts as decimal strings. */
export type PaymentAccount = {
  address: string;
  contract: string;
  priceWeiPerUnit: string;
  balance: string;
  held: string;
  available: string;
  spendLimitPerEpoch: string;
  withdrawal: { amount: string; epoch: number; requestedAt: number; ready: boolean } | null;
};
export type JobDetail = ApiJob & {
  params?: Record<string, number | undefined>;
  note?: string | null;
  /** URL of the output; with private outputs on, only when this caller may read it. */
  output?: string | null;
  /** An agreed output is stored (whether or not this caller may read it). Absent on older schedulers. */
  outputAvailable?: boolean;
  outputType?: string | null;
};

export type ApiNode = {
  owner: string;
  nodeKey: string;
  gpu: string;
  vramMb: number;
  /** Added with the iGPU / CPU text mode; absent on older schedulers (treated as cuda). */
  backend?: "cuda" | "vulkan" | "cpu";
  caps: string[];
  online: boolean;
  lastSeen: number;
  agreedJobs: number;
  epochAgreedJobs: number;
  dev?: boolean;
  /** Run by the project (bootstrap GPU pool), never paid. Absent on older schedulers. */
  project?: boolean;
  /** A project node paid on purpose for the team's labelled payout test. */
  paidTest?: boolean;
};
export type NodesResponse = { nodes: ApiNode[] };

export type ProofResponse = {
  epochId: number;
  account: string;
  amount: string;
  leaf: string;
  proof: string[];
  root: string;
  status?: EpochStatus;
};

export type TreeResponse = {
  id: number;
  root: string;
  reserved: string;
  status?: EpochStatus;
  potAtClose?: string | null;
  postedTx?: string | null;
  leaves: { account: string; amount: string; leaf: string }[];
};

/** GET /api/v1/status with the fields the scheduler adds beyond the shared type. */
export type StatusResponse = Omit<SchedulerStatus, "epoch" | "lastSettled"> & {
  epoch: {
    id: number;
    startedAt: number;
    endsAt: number;
    length: number;
    clock?: "contract" | "scheduler-local";
    provisional?: boolean;
    note?: string | null;
  } | null;
  /** "enforce": outputs are readable only with the job's read secret or the paying wallet's sign-in. Absent on older schedulers. */
  outputAuth?: "off" | "enforce";
  /** Bootstrap GPU pool (project-run nodes started on demand). Absent on older schedulers. */
  gpuPool?: { configured: boolean; state?: "unknown" | "starting" | "running" | "stopping" | "stopped"; idleMinutes?: number; error?: string | null };
  lastSettled: {
    id: number;
    root: string | null;
    reserved: string;
    leaves: number;
    postedTx: string | null;
    status?: EpochStatus;
  } | null;
};

export type ApiFailure =
  | { kind: "unreachable"; message: string }
  | { kind: "http"; status: number; code: string | null; message: string | null; extra: Record<string, unknown> };

export type ApiResult<T> = { ok: true; data: T; headers: Headers } | { ok: false; failure: ApiFailure };

/** fetch + JSON with a typed failure. A non-JSON error page counts as an HTTP failure without a code. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { cache: "no-store", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ok: false, failure: { kind: "unreachable", message: e instanceof Error ? e.message : "network error" } };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || body === null) {
    const { error, message, ...extra } = body ?? {};
    return {
      ok: false,
      failure: {
        kind: "http",
        status: res.status,
        code: typeof error === "string" ? error : null,
        message: typeof message === "string" ? message : null,
        extra,
      },
    };
  }
  return { ok: true, data: body as T, headers: res.headers };
}

/** True when the failure means "the scheduler API itself is not there" rather than a normal 4xx answer. */
export const apiDown = (f: ApiFailure) =>
  f.kind === "unreachable" || f.status >= 500 || (f.status === 404 && (f.code === null || f.code === "not-found"));
