# Private job outputs

Who can read the output of a Sparecycle job, how, and what this does not protect. Code: `src/server/auth.ts`,
`src/server/jobs.ts` (`jobOutput`, `jobDetail`, `submitJob`), `src/app/api/v1/jobs/[id]/result/route.ts`,
`src/app/api/v1/auth/*`. Tests: `npm run test:private-outputs`, `npm run e2e:local` (step 17).

## Who can read what

With `OUTPUT_AUTH=enforce`:

| Job | Can read the output |
| --- | --- |
| Free trial job | Only a request with the job's **read secret** (`Authorization: Bearer <readSecret>`). The dapp keeps it in the local history of the browser that submitted the job. There is no wallet, so no other device can read it. |
| Paid job | The job's read secret, **or** a signed-in session of the wallet that paid (`jobs.payer`), on any device. |
| Team job (payer in `TEAM_JOB_WALLETS`) | The job's read secret, or a session of that team wallet. |
| Anyone else | Nobody. Knowing or listing a job id (`GET /api/v1/jobs` lists them) is not enough. There is no operator backdoor. |
| GPU nodes | A node's signed request (`x-sc-*` headers) is never a credential for outputs. A node receives a job's spec only while the job is `queued`, `running` or `checking`, and its own copy of the output in `results.output` is deleted at the verdict (and when a job expires). |

What is **not** private:

- **The two GPU nodes of a job see the prompt and produce the output** while they work. Whatever reached their machines
  cannot be recalled.
- **Payments are public.** The payments contract emits `CustomerCharged` (payer and amount per epoch) on-chain. The
  per-epoch charge answer (`GET /api/v1/epochs/{id}/charges`) shows each paying wallet's total and the leaf hashes of the
  jobs tree; charge lists made before job receipts also link charged job ids to paying wallets and prices. Every leaf
  includes 32 random bytes (a salt) that are given only in the payer's job receipt (`GET /api/v1/jobs/{id}/receipt`,
  same credentials as the invoice), so the public leaves cannot be matched to a job or a wallet: job ids, verdicts and
  prices are public, but the salt is not.
  Public job views keep only `payment` (free / paid / team); a job's price, charge status and output hash are on its
  private invoice (`GET /api/v1/jobs/{id}/invoice`, same credentials as the output, always enforced).
- **Outputs made before this change** were served with `Cache-Control: public, max-age=31536000, immutable` to anyone
  with the job id. They may already have been viewed, downloaded, or cached by browsers or proxies. Those copies cannot
  be recalled.
- Prompts are still stored in clear in the scheduler database (`jobs.spec`) and in its backups on the private volume.
  They are never returned by any API.

## Read secrets

`POST /api/v1/jobs` (free and paid) answers with one extra field:

```json
{ "id": "0x…", "status": "queued", "priceWei": null, "readSecret": "<43 characters, base64url of 32 random bytes>" }
```

- The secret is returned **once**. The scheduler stores only `sha256(readSecret)` in `jobs.read_secret_hash` and
  compares in constant time.
- Send it as `Authorization: Bearer <readSecret>`. Never in a query string: those end up in logs and browser history,
  and the scheduler ignores them.
- One secret reads one job. A lost secret can't be recovered. A paid job's output can still be read by the payer's
  wallet sign-in.

## Wallet sign-in (EIP-4361)

All three routes answer `Cache-Control: private, no-store` and `Vary: Authorization, Cookie`. Errors are
`{ "error": "<code>", "message": "…" }`.

### `GET /api/v1/auth/nonce`

```json
{ "nonce": "<alphanumeric>", "expiresAt": 1764000600, "chainId": 4663, "version": "1",
  "statement": "Sign in to Sparecycle to view the results of jobs this wallet paid for. No transaction and no gas." }
```

The nonce is single-use and valid for 10 minutes. At most 60 nonces per client IP per hour (`429 rate-limited`).

### `POST /api/v1/auth/verify`

Request (`Content-Type: application/json` is required; anything else gets `415 json-required`):

```json
{ "message": "<EIP-4361 message>", "signature": "0x…" }
```

The message must name:

- `domain`: the host the request is sent to, or one of `AUTH_DOMAIN`. The `uri` must be on the same host.
- `chainId`: the target chain id of the deployment (4663 on mainnet, 46630 on testnet, 31337 locally).
- `nonce`: one issued by `GET auth/nonce`, unused and not expired.
- `version: 1` and `issuedAt` (at most 10 minutes old, at most 5 minutes in the future). An `expirationTime` or
  `notBefore`, if present, must hold.

The nonce is spent before the signature is checked, so a message can be presented only once. The signature is checked
like a node owner's link signature: as an EOA signature first, then through the chain for ERC-1271 / ERC-6492 smart
wallets.

Success (`200`):

```json
{ "ok": true, "address": "0xChecksummed…", "expiresAt": 1764043200 }
```

with `Set-Cookie: sc_session=<id>; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=43200; Secure`. `Secure` is left out
only when the site is served on `localhost` / `127.0.0.1` (local tests over plain http). Sessions last 12 hours. The
scheduler stores only `sha256(session id)`.

Errors: `400 invalid-sign-in`, `401 wrong-domain`, `401 wrong-chain`, `401 stale-sign-in`, `401 bad-nonce`,
`401 bad-signature`.

### `POST /api/v1/auth/logout`

Deletes the session and answers `{ "ok": true }` with `Set-Cookie: sc_session=; …; Max-Age=0`.

## Output routes

### `GET /api/v1/jobs/:id/result` (also `HEAD`)

Credentials: the read secret (`Authorization: Bearer`) and/or the session cookie. With `OUTPUT_AUTH=enforce`:

| Case | Answer |
| --- | --- |
| No credentials (or only an expired/unknown session) | `401`, empty body, `WWW-Authenticate: Bearer realm="sparecycle"` |
| Unknown job id | `404 unknown-job` |
| Credentials that can't read this job (wrong secret, another wallet, a session on a free job, a legacy free job) | `403 forbidden` |
| Job not agreed | `409 no-output` |
| Allowed | `200`, `image/png` or `text/plain; charset=utf-8` |
| Malformed id | `400 invalid-job-id` |
| More than `OUTPUT_RATE_LIMIT` reads in an hour | `429 rate-limited` (`retryAfter` seconds) |

With `OUTPUT_AUTH=off` the same route serves any agreed output without credentials (404 / 409 as above).

The rate limit counts per viewer: per job for a valid read secret, per wallet for a valid payer session, otherwise per
client IP (salted hash in `rate_limits`).

### `GET /api/v1/jobs/:id/output` (retired)

- `OUTPUT_AUTH=enforce`: `410 gone`, `Cache-Control: private, no-store`, with or without credentials. Any shared cache
  keyed on the old URL can only serve what it already held.
- `OUTPUT_AUTH=off`: serves the agreed output to anyone, as before, but with `Cache-Control: private, no-store`
  (never `public, immutable` again).

### `GET /api/v1/jobs/:id`

Unchanged fields, plus:

- `outputAvailable`: `true` when an agreed output is stored, for every caller.
- `output`: `"/api/v1/jobs/:id/result"` when the output is available **and** the caller may read it (any caller while
  `OUTPUT_AUTH=off`), else `null`.

### Headers

Every response of `jobs/:id`, `jobs/:id/result`, `jobs/:id/output`, `POST jobs` and `auth/*`, errors included, carries
`Cache-Control: private, no-store` and `Vary: Authorization, Cookie`. `GET /api/v1/status` reports
`outputAuth: "off" | "enforce"`. The dapp uses it so the privacy notice never claims more than the scheduler does.

## Flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `OUTPUT_AUTH` | `off` | `enforce` turns on the rules above. Rollback: set `off` again. The headers stay `private, no-store`. Migrations are additive. |
| `OUTPUT_RATE_LIMIT` | `600` | Output reads per viewer per hour. |
| `AUTH_DOMAIN` | unset | Sign-in domain(s), comma-separated. Unset = the host the request was sent to. Recommended in production: the public host, e.g. `sparecycle.tech`. |

Sign-in needs the dapp and the API on the same site (the default `NEXT_PUBLIC_SCHEDULER_API_URL=/api/v1`), because the
session cookie is `SameSite=Strict`.

## Legacy jobs (created before this change)

They have no `read_secret_hash`.

- Legacy **free** jobs: unreadable by anyone once `OUTPUT_AUTH=enforce`. There is no wallet to check and no secret was
  ever issued. Their bytes stay in the database (no retention policy).
- Legacy **paid / team** jobs: readable by the paying wallet after sign-in.
- The dapp shows "only in the browser that made it" for free jobs it holds no secret for, and "Sign in to view" for
  paid jobs.

## Client

`src/lib/dapp/job-output.ts`: `fetch(resultUrl, { headers: { Authorization: "Bearer <secret>" }, credentials: "include" })`
then `URL.createObjectURL(blob)`. The URL is revoked on unmount or change. An `<img src>` can't carry the secret. The
read secret is stored with each job in the local history (`sparecycle.playground`, `sparecycle.my-jobs`). Download (PNG)
uses the same blob URL. Without a stored secret, paid and team jobs offer a wallet sign-in (EIP-4361 message, no gas)
and are fetched again with the cookie.

## Database (migration "v4 (private outputs)")

```sql
ALTER TABLE jobs ADD COLUMN read_secret_hash TEXT;
CREATE TABLE auth_nonces (nonce TEXT PRIMARY KEY, address TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX auth_nonces_expires ON auth_nonces(expires_at);
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, address TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE INDEX sessions_expires ON sessions(expires_at);
```

Expired nonces (after one more hour) and sessions are deleted when new ones are created.

## Rollout

1. Deploy with `OUTPUT_AUTH=off`. The new headers are live immediately, the dapp already reads `/result` with the secret,
   and new jobs get secrets.
2. Check sign-in and reads on testnet or locally (`npm run e2e:local`).
3. Set `OUTPUT_AUTH=enforce` (and `AUTH_DOMAIN`). Smoke test in production: `HEAD /api/v1/jobs/<id>/output` returns
   `410` with `no-store`, and an anonymous `GET /api/v1/jobs/<fresh agreed id>/result` returns `401`.
4. If a CDN or proxy sits in front of the site, bypass its cache for `/api/*` and purge `/api/v1/jobs/*/output` once.
   None was seen in the live response headers (Railway edge only). Whether Railway's edge cached the old
   `public, immutable` responses is still to be confirmed.
