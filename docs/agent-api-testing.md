# Agent API: how it was tested

Covers API keys (`src/server/apikeys.ts`), the OpenAI-compatible API (`src/server/openai.ts`) and the MCP server
(`src/server/mcp.ts`). Local only: no production DB, no live chain, no call to the live site.

## Unit and route tests (`npm test`)

Scratch SQLite DB, local-chain config with no reachable RPC, chain reads stubbed (balances, spend limits, ERC-1271
wallets), two in-process dev nodes that agree or disagree on demand. The real route handlers are called directly.
Shared harness: `src/server/test-support/agent-api.ts`.

| File | Brief acceptance list |
| --- | --- |
| `src/server/apikeys.test.ts` | 1.6: session-only key routes (401 private, no-store), secret shown once and stored as sha256, pending until a valid link signature (EOA and ERC-1271), key-paid jobs (payer, api_key_id, no payment_sig, no read secret), 429 key-daily-cap / 402 / 401 after disable, price back on disagreed / expired / rejected, kill switch (queued jobs expired "cancelled: API key disabled", released at charge), apiKeyId in the charge list, no withdraw path, own-jobs-only reads, read secrets still work, spend-limit banner rule, MAX_KEYS, cap raise needs a new signature, no key in any log line |
| `src/server/openai.test.ts` | 2.9 (in-process part): 202 shapes, poll, `Prefer: wait` and its cap, Idempotency-Key (incl. concurrent duplicates), stream 400, limits with `param`, 404 model_not_found, 401 / 403, 422 not_charged (mismatch, expired, safety checker), no usage, finish_reason_reported false, b64_json PNG size, url format, models list |
| `src/server/mcp.test.ts` | 3.3 (in-process part): legacy initialize / notifications / ping / tools/list, modern 2026-07-28 rules (headers, -32020, -32022, 404 -32601, server/discover), exactly four tools with JSON schemas, submit -> status -> result (text and image content), auth errors, forbidden, not-charged tool errors, cap, kill switch, get_balance |
| `src/lib/openapi-agent.test.ts` | the OpenAPI fragments: every `$ref` resolves, every path has a route file |

## End to end against `next start` (26 Nov 2026)

Setup, all in scratch locations: anvil on 127.0.0.1:8604 (chain 31337) with SparecycleRewards, MockPonsFeeEscrow,
SparecycleJobPayments and an ERC-1271 mock wallet deployed from the public anvil dev accounts; deposits from two EOAs
and the mock wallet; `next build` and `next start -p 3304` with `DB_PATH` under the gitignored `data/agent-api-e2e/`,
`OUTPUT_AUTH=enforce`, `SCHEDULER_ALLOW_DEV_RUNNER=1`, `API_MAX_WAIT_SECONDS=20`; two scripted dev nodes signing like
the node client (a prompt containing "MISMATCH" makes one node answer differently). Keys were created through the real
sign-in and key routes; the ERC-1271 key was activated through the chain. The SDKs were installed in a scratch folder
outside the repository (`%TEMP%\sc-openai-test`), never in the repo.

| Check | Version | Result |
| --- | --- | --- |
| Official OpenAI JS SDK | `openai@7.64.0` | 14/14 |
| Official OpenAI Python SDK | `openai==3.59.0` (Python 3.10, pydantic 2.14.4) | 5/5 |
| Scripted JSON-RPC MCP client over HTTP | (no SDK) | 8/8 |
| MCP Inspector CLI | `@modelcontextprotocol/inspector@2.16.0` | see below |

JS SDK checks: `models.list()` = exactly qwen2.5-1.5b and sd15 on `/v1` and `/api/v1`; `chat.completions.create`
-> parsable 202 with `sparecycle.job_id`, `retrieve(id)` -> the agreed text, no `usage`,
`finish_reason_reported: false`; the same completion through `/v1` and `/api/v1`; `Prefer: wait` via `defaultHeaders`
-> 200; `images.generate` -> poll with `client.get()` -> `b64_json` PNG of the requested size; `response_format: "url"`
-> gated `/result` (200 with the key, 403 with another key, 401 without); 404 model_not_found; 400
streaming_not_supported; 400 with `param`; forced mismatch -> `UnprocessableEntityError` 422 results_did_not_match,
job disagreed and not charged; a create that timed out client-side (`timeout: 1500`, `maxRetries: 2`) and was retried
with one Idempotency-Key -> one job; 403 PermissionDeniedError / 401 AuthenticationError; the ERC-1271 wallet's key pays
and reads; every response `private, no-store`.

Python SDK checks: the docs examples (`with_raw_response` 202, `model_extra["sparecycle"]`, `retrieve`,
`images.generate(extra_body=…)`, `client.get(…, cast_to=object)`), 422 / 404 / 400 / 403.

The server log of the run held no API key and no prompt.

## Notes for the integrator

- `next build` with Turbopack refuses a worktree whose `node_modules` is a junction to another checkout (it resolves
  outside the project root). The e2e build ran from a scratch copy of the app whose `next.config.ts` set
  `turbopack.root` to the common parent folder; the committed `next.config.ts` is unchanged apart from `rewrites()`.
- `API_MAX_WAIT_SECONDS` defaults to 25 s. Railway's request timeout was not checked; keep the value below it.
