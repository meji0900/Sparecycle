// Support form (POST /api/support, the form on /docs/support). A short message is forwarded to SUPPORT_WEBHOOK_URL
// (a Discord or Slack incoming webhook, the same pattern as ALERT_WEBHOOK_URL) and nothing is stored: no table, no
// log line with the content, nothing echoed back. Off (503) until the URL is set. Rate limited per salted IP hash,
// like free jobs. Who reads the channel behind the webhook, and how replies work, is decided when it is switched on.
import { getAddress, isAddress } from "viem";
import { ApiError } from "./http";
import { limitBucket, takeHourly } from "./limits";

export const SUPPORT_TOPICS = [
  { id: "first-job", label: "Running a job" },
  { id: "billing", label: "Balance, charges or withdrawals" },
  { id: "node", label: "Running a node" },
  { id: "api", label: "The API" },
  { id: "contracts", label: "Contracts or payouts" },
  { id: "other", label: "Something else" },
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number]["id"];

export const SUPPORT_LIMITS = {
  message: { min: 10, max: 2000 },
  /** Messages per IP address per hour. */
  perHour: 5,
  bodyBytes: 8 * 1024,
  webhookTimeoutMs: 10_000,
} as const;

/** The webhook, only when it is an https URL. Read per request, so setting it needs no rebuild. */
export function supportWebhookUrl(): string | null {
  const s = process.env.SUPPORT_WEBHOOK_URL?.trim();
  return s && /^https:\/\//i.test(s) ? s : null;
}
export const supportEnabled = () => supportWebhookUrl() !== null;

export type SupportRequest = { topic: SupportTopic; wallet: string | null; jobId: string | null; message: string };

const bad = (field: string, message: string): never => {
  throw new ApiError(400, "invalid-support-request", message, { field });
};

const optionalText = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Validates the form body. Error messages name the field, never repeat what was sent. */
export function parseSupportRequest(body: unknown): SupportRequest & { trap: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("body", "expected a JSON object");
  const b = body as Record<string, unknown>;
  const topic = SUPPORT_TOPICS.find((t) => t.id === b.topic)?.id;
  if (!topic) bad("topic", "pick one of the topics");
  const walletRaw = optionalText(b.wallet);
  if (walletRaw !== null && !isAddress(walletRaw)) bad("wallet", "wallet must be a 0x address, or left empty");
  const jobRaw = optionalText(b.jobId);
  if (jobRaw !== null && !/^0x[0-9a-fA-F]{64}$/.test(jobRaw)) bad("jobId", "job id must be 0x followed by 64 hex characters, or left empty");
  if (typeof b.message !== "string") return bad("message", "message must be text");
  const message = b.message.trim();
  const { min, max } = SUPPORT_LIMITS.message;
  if (message.length < min || message.length > max) bad("message", `message must be ${min} to ${max} characters`);
  for (let i = 0; i < message.length; i++) {
    const c = message.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) bad("message", "message contains control characters");
  }
  return {
    topic: topic as SupportTopic,
    wallet: walletRaw ? getAddress(walletRaw) : null,
    jobId: jobRaw ? jobRaw.toLowerCase() : null,
    message,
    // A field people never see; bots that fill every input fill it too.
    trap: optionalText(b.website) !== null,
  };
}

/** Slack reads `text` as mrkdwn, where <…> can mention people: escape it. Discord reads `content`; mentions are off. */
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function supportWebhookPayload(r: SupportRequest) {
  const label = SUPPORT_TOPICS.find((t) => t.id === r.topic)?.label ?? r.topic;
  const lines = [`Sparecycle support: ${label}`, `Wallet: ${r.wallet ?? "not given"}`, `Job: ${r.jobId ?? "not given"}`, "", r.message];
  const text = lines.join("\n");
  return { content: text.slice(0, 1900), text: slackEscape(text), allowed_mentions: { parse: [] as string[] } };
}

/**
 * POST /api/support. 503 support-off until SUPPORT_WEBHOOK_URL is set; 400 for a bad field; 429 after
 * SUPPORT_LIMITS.perHour messages from one IP in an hour; 502 when the webhook does not take it (nothing is kept,
 * so the sender can simply try again). Returns { ok: true } and nothing else.
 */
export async function submitSupport(body: unknown, ip: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true }> {
  const url = supportWebhookUrl();
  if (!url) throw new ApiError(503, "support-off", "the support form is not switched on yet");
  const req = parseSupportRequest(body);
  takeHourly(limitBucket("support", "ip", ip), SUPPORT_LIMITS.perHour, "support messages from one address");
  if (req.trap) return { ok: true };
  let status = 0;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(supportWebhookPayload(req)),
      signal: AbortSignal.timeout(SUPPORT_LIMITS.webhookTimeoutMs),
    });
    status = res.status;
  } catch {
    status = 0;
  }
  if (status < 200 || status >= 300) {
    // The status code only: never the message, the wallet or the webhook URL.
    console.error(`[sparecycle] support webhook did not accept a message (status ${status || "no answer"})`);
    throw new ApiError(502, "support-unavailable", "the message could not be delivered and was not kept; please try again later");
  }
  return { ok: true };
}
