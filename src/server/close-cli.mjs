#!/usr/bin/env node
// `npm run scheduler:close` — tells the running scheduler to close the open epoch (same as the autoclose timer).
//   SCHEDULER_URL          base URL of the site (default http://127.0.0.1:3000)
//   SCHEDULER_ADMIN_TOKEN  the scheduler's admin token (sent as a Bearer token, never printed)
const base = (process.env.SCHEDULER_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const token = process.env.SCHEDULER_ADMIN_TOKEN;
if (!token) {
  console.error("SCHEDULER_ADMIN_TOKEN is not set");
  process.exit(1);
}
const res = await fetch(`${base}/api/v1/epochs/close`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
const body = await res.text();
console.log(`${res.status} ${body}`);
process.exitCode = res.ok ? 0 : 1;
