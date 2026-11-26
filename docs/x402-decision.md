# x402 pay-per-job: decision record and build notes

**Status (26 Nov 2026):** built on branch `feat/x402`. **Internal review only, not externally audited.** It is meant as a
capped launch. The server flag `X402_ENABLED` is off by default; the integrator turns it on only after the escrow is
deployed and the preflight passes.

**Decisions:**
- **A13 = X1**, a non-custodial per-job escrow (`contracts/src/SparecycleX402Escrow.sol`). Default, not yet confirmed by Fabio. **Never X3.**
- **A14 = USDG** on Robinhood Chain (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`). Default, not yet confirmed by Fabio. Verified on-chain below.

**Still open with Fabio:** the legal review of the paid surface, the price per work unit, the caps, and the address that converts USDG for the pot (`forwardTo`).

Until x402 is switched on, agents pay through a prepaid wallet balance and an API key (`/docs/api/keys`,
`/docs/api/openai`, `/docs/api/mcp`). Another option, X2 (`depositFor` in a future payments contract, next-update
brief §8), stays possible later. It is not built here.

## 1. Verified facts

### 1.1 The x402 protocol

Source: https://github.com/x402-foundation/x402 at commit `be1440e`, read 26 Nov 2026. The old `coinbase/x402` README
now points there. Docs: docs.x402.org.

**Version.**
- The current spec is **x402 v2** (`specs/x402-specification-v2.md`, v2.0 of 9 Dec 2025).
- The v1 TypeScript packages are deprecated.
- The x402 TS server reads only the v2 header.

**Headers.** Each carries base64 JSON (`specs/transports-v2/http.md`).

| Header | Sent by | Carries | v1 name |
| --- | --- | --- | --- |
| `PAYMENT-REQUIRED` | server, with the `402` | PaymentRequired | (none) |
| `PAYMENT-SIGNATURE` | client, on the retry | PaymentPayload | `X-PAYMENT` |
| `PAYMENT-RESPONSE` | server, on success | SettleResponse | `X-PAYMENT-RESPONSE` |

**PaymentRequired** = `{x402Version: 2, error?, resource: {url, description?, mimeType?, serviceName?}, accepts: [PaymentRequirements], extensions?}`.

**PaymentRequirements** = `{scheme, network (CAIP-2, e.g. eip155:4663), amount (atomic units), asset, payTo, maxTimeoutSeconds, extra}`.

**PaymentPayload** = `{x402Version, accepted, payload: {signature, authorization: {from, to, value, validAfter, validBefore, nonce}}}`.

**SettleResponse** = `{success, transaction, network, payer?, amount?, errorReason?}`.

**Scheme `exact` on EVM** (`specs/schemes/exact/scheme_exact_evm.md`):
- `assetTransferMethod` is one of `eip3009` (the default), `permit2` (Uniswap Permit2 through `x402ExactPermit2Proxy`) or `erc7710`.
- EIP-2612 appears only as a gas-sponsoring extension.
- The EIP-3009 typed data is `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`.
- Its domain is `{name: extra.name, version: extra.version, chainId, verifyingContract: asset}`.

**Facilitator** (spec §7):
- `POST /verify` and `POST /settle` both take `{x402Version, paymentPayload, paymentRequirements}`.
- `GET /supported` lists `{kinds, extensions, signers}`.
- A standard `exact` settle calls the token directly and **pays `payTo`**.

**Refunds** (spec §6.1):
- `exact` has no refund. In the default flow the server settles only after the work succeeded.
- The `auth-capture` scheme (`AuthCaptureEscrow`: authorize / capture / void / refund) is an escrow-native alternative. It is **not** verified on Robinhood Chain.

**SDK.**
- `@x402/evm` 2.31.0 added Robinhood Chain (4663) with USDG as an EIP-3009 asset (name "Global Dollar", version "1", 6 decimals).
- Latest on npm (26 Nov 2026): `@x402/core`, `@x402/evm`, `@x402/next` and `@x402/fetch`, all 2.32.0.
- **No x402 package is installed or needed.** The server implements the wire format itself (`src/lib/x402.ts`). If a package is wanted later, it would be `@x402/core` + `@x402/evm`.

### 1.2 Facilitators that list Robinhood Chain

Each live `GET /supported` was read on 26 Nov 2026; no payment was sent.

| Facilitator | eip155:4663? | What it lists |
| --- | --- | --- |
| Coinbase CDP (docs.cdp.coinbase.com/x402) | **No** | Its docs list Base, Polygon, Arbitrum, Monad, World and Solana. Its `/supported` needs auth (401). |
| x402.org | **No** | Testnets only. |
| PayAI, Daydreams, OpenX402, Mogami, Radius, Primev, X Pay | **No** | |
| Dexter (`x402.dexter.cash`) | **Yes** | v2 `exact` with USDG via **permit2**, `upto`, `batch-settlement`. Signer `0x402Feee072D655B85e08f1751AF9ddbCd249521f`. |
| Solvador (`api.solvador.com`) | **Yes** | v2 `exact`, `upto`, `batch-settlement`. |
| Ultravioleta DAO (`facilitator.ultravioletadao.xyz`) | **Yes** | v1 `robinhood` with USDG, and v2 entries. |
| thirdweb, Heurist, Corbits, x402.rs | unknown | Needed auth, errored, or answered 404. |

**Facilitator choice:** the Sparecycle scheduler is its own facilitator (`LocalFacilitator` in `src/server/x402.ts`).
- It verifies the signed authorization locally (signature, recipient, amount, validity window, nonce unused, balance).
- It settles by calling `SparecycleX402Escrow.fund()` from the scheduler key, which pays the gas.
- The third parties above cannot settle for X1. Their `exact` settle pays `payTo` directly, which would put the money into the escrow contract without an escrow record.
- The facilitator interface allows a swap later:
  - `X402_FACILITATOR_URL` adds a third party's `/verify` after the local checks (`RemoteVerifyFacilitator`).
  - Leave it unset on mainnet: it adds no check and shows the signed authorization to that party.
  - A third party with an escrow scheme that matches this contract could take `settle`.

### 1.3 USDG on Robinhood Chain: what the chain says

Read with `eth_getCode`, `eth_getStorageAt` and `eth_call` at blocks 123,601,008 to 123,601,373 (26 Nov 2026), through the read-only relay `sparecycle.tech/api/rpc` and the public RPC pinned to `104.20.46.209`. `eth_chainId` = `0x1237` (4663).

**Proxy and implementation.**
- The token is an **EIP-1967 proxy**. The implementation slot holds `0x68184c449e1a8f34fa18d289737129fd27b66f8f`; the admin slot is 0.
- The implementation has `upgradeTo`, `upgradeToAndCall` and `proxiableUUID`, so the token is **upgradeable (UUPS)** by its issuer.
- The implementation's fallback forwards some selectors to modules, through a `mapping(bytes4 => address)` at storage slot `0x112`.

**EIP-3009 and EIP-2612 module.** `0x780d30b6a89bc9eef953a543aa288c3b05b01309`. Every selector below is in its dispatcher:

| Selector | Function |
| --- | --- |
| `0xe3ee160e` | `transferWithAuthorization` (v,r,s) |
| `0xcf092995` | `transferWithAuthorization` (bytes) |
| `0xef55bec6` | `receiveWithAuthorization` (v,r,s) |
| `0x88b7ab63` | `receiveWithAuthorization` (bytes) |
| `0x5a049a70` | `cancelAuthorization` |
| `0xe94a0102` | `authorizationState` |
| `0xa0cc6a68` | `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` |
| `0xd505accf` | `permit` (EIP-2612) |
| `0x9fd5a6cf` | `permit` (bytes) |
| `0x7ecebe00` | `nonces` |

**Pause, freeze and wipe module.** `0x58cab81e3d8468a0e90df8cbfacb34535e1de942`, with `paused`, `pause`, `isFrozen`, `freeze` and `wipeFrozenAddress`. `paused()` was false.

**Token metadata.**
- `name()` = "Global Dollar", `symbol()` = "USDG", `decimals()` = 6.
- `DOMAIN_SEPARATOR()` = `0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036`. This equals the EIP-712 domain ("Global Dollar", "1", 4663, the USDG address), recomputed locally.
- `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` is the standard EIP-3009 value.
- `version()` and `eip712Domain()` revert, so the domain version must be configured (`X402_ASSET_VERSION=1`) and is checked at boot.

**Conclusion for A14:** USDG supports EIP-3009 (the x402 `exact` default) and EIP-2612. Risks: Paxos can freeze, pause or wipe addresses and can upgrade the token.

**Also on chain 4663:**
- Uniswap Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` has code (9,152 bytes).
- `x402ExactPermit2Proxy` `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` has code (2,913 bytes).

So `_pull` could move to Permit2 later.

### 1.4 The live reward contract

Read with `eth_call` on 26 Nov 2026 at `0x68A0569130551154FC1aABD71d99f65681c58Fe9`:
- `payoutToken()` = `0x0`: the pot pays **ETH**.
- `scheduler()` = `0xc062625d4bD24bcE5C8b62F950A38C962CF240B6`.
- `owner()` = the treasury Safe.
- `currentEpoch()` = 9.

## 2. What was built (X1)

### 2.1 Contract

`contracts/src/SparecycleX402Escrow.sol`, marked INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.

**One escrow per job.**
- It is keyed by `escrowId = keccak256(abi.encode(jobId, salt))`. The salt is private, so the public events do not name the job.
- Each escrow holds the payer, the amount, a deadline (funding time + `settleWindow`) and one terminal state: `Held`, then `Forwarded` or `Refunded`.

**`fund` (scheduler key only, `rewards.scheduler()`):**
- It pulls the payer's EIP-3009 authorization (to = the escrow, value = the price) through the internal `_pull`. Permit2 could replace that function later.
- It requires the measured balance increase to equal the amount, so **fee-on-transfer tokens are refused**.
- It checks the caps.

**`forward` (scheduler only, up to the deadline).** 5% goes to the treasury. The other 95%:
- goes to `rewards.fundToken()` if the pot is paid in the asset;
- otherwise goes to **`forwardTo`** for conversion, with a `Forwarded(..., potRecipient, forConversion=true)` event.

Nothing reaches the pot or `forwardTo` before agreement.

**`refund`.** The scheduler can refund at any time while the escrow is held. **Anyone** can refund after the deadline.

**Capped launch.**
- The caps are `maxPerJob`, `maxTotalHeld` and `maxPerPayerPerEpoch`. The last one counts what a payer funded per reward-contract epoch.
- The owner (the treasury Safe) can change all three, set `forwardTo`, pause new funding, and recover tokens that are in no escrow (`recoverSurplus`: only the balance above `totalHeld`).
- The owner **cannot move a held escrow**. Renouncing ownership is blocked.

**Payout asset (A14 consequence).**
- The pot pays ETH and the payment is USDG, so option (a) is built: the pot share goes to a Safe-controlled `forwardTo`. Converting it and calling `fund()` on the reward contract is a separate, manual Safe transaction.
- Option (b), a swap with `minOut`, was not chosen. No pool or price feed for USDG/ETH on Robinhood Chain was verified on-chain (the pools in the next-update brief come from third-party data), and an on-chain swap adds slippage and MEV surface.
- Open: who converts, how often, and how that is disclosed.

**Tests (Foundry):**
- `test/SparecycleX402Escrow.t.sol`: 25 unit tests. They cover fund, caps, pause, fee-on-transfer, expired authorization, reuse, wrong recipient or payer, the forward split (fuzzed), forward to the pot directly, the deadline boundary, refund by anyone after the deadline, scheduler rotation, reentrancy during fund / forward / refund, owner powers, surplus recovery and the front-run authorization.
- `test/invariant/SparecycleX402Escrow.invariant.t.sol`: 4 invariants, 256 runs × 64 calls.
  - The balance equals held plus surplus.
  - Conservation: every unit funded is still held, forwarded or refunded.
  - Each escrow ends exactly once.
  - Outflows go only to forwardTo, the treasury, the payers or the recovery target, in the booked amounts.
- `test/DeployX402Escrow.t.sol` runs the deploy script itself.

### 2.2 Server

**`src/server/x402.ts` and `src/lib/x402.ts`:**
- **402.** `POST /v1/chat/completions` and `POST /v1/images/generations` (under `/v1` and `/api/v1`), sent with no `Authorization` header and with x402 on, answer `402`:
  - a `PAYMENT-REQUIRED` header;
  - the body error codes `x402_payment_required` / `x402_payment_rejected`;
  - one requirement: `exact`, `eip155:<chain>`, `amount = workUnits × X402_PRICE_PER_UNIT` (the `jobPriceWei` rule in asset units), `payTo` = the escrow, `extra = {name, version, assetTransferMethod: "eip3009"}`, and a `sparecycle-escrow` extension.

  The prepaid-balance `402 insufficient_balance` is unchanged: no x402 header, its own code.
- **Pay.**
  - The facilitator verifies the payment, then the scheduler funds the escrow.
  - **The job is queued only after the funding transaction succeeded.** It is marked held in the same SQLite transaction as the job insert.
  - The `202` answer carries `PAYMENT-RESPONSE` and a one-time read secret.
  - Polling the OpenAI-compatible routes uses that secret, which works for x402 jobs only.
  - x402 jobs have `charge_status = 'x402'` and no wei price, so the prepaid charge path never touches them.
- **Settle.** A 15 s timer:
  - agreed: `forward`;
  - disagreed, expired, rejected, not queued, or past the deadline: `refund`.

  Each step is stored before and after its transaction and re-read from the chain. Settlement runs whatever the flag says, with each row's own escrow address, so switching x402 off never strands an escrow.
- **Epoch.** Each close builds an x402 tree. It is the same sorted-pair keccak tree with salted leaves as the receipts tree, with the leaf rule in `src/lib/x402.ts`, and is served as an `x402` block of `GET /api/v1/epochs/:id/charges`.
  - The payer's `GET /jobs/:id/receipt` returns a `sparecycle-x402-receipt` with the escrow salt, the leaf salt and the proof.
  - There is no on-chain root. Each outcome is on-chain as the escrow's `Funded` / `Forwarded` / `Refunded` events.
- **Preflight.** At boot, and every 60 s while serving, the server checks:
  - the escrow's asset and reward contract;
  - that the reward contract's scheduler is the signer key;
  - the asset's `DOMAIN_SEPARATOR` against `X402_ASSET_NAME` / `X402_ASSET_VERSION`;
  - that `settleWindow` ≥ job TTL + 1 h.

  On a mismatch the server takes no payments (`503 x402_unavailable`). It offers no `402` above `maxPerJob` (`400`) or while funding is paused (`503`).
- **Migration** in `src/server/db.ts`, called **v12** (additive): `x402_escrows`, `x402_leaves`, `x402_roots`.
- **OpenAPI** entries are marked "only where x402 is switched on … INTERNAL REVIEW ONLY". The `/docs/api#x402` section says the same.

**Tests:**
- `src/server/x402.test.ts`: 23 tests, using a mock escrow chain, a mock facilitator and the real routes.
- `E2E_X402=1 npm run e2e:local` adds the anvil flow: a mock EIP-3009 token and the escrow; 402, pay, fund, agreed, forwarded; the sealed receipt checked against the on-chain events; and a disagreed job refunded.
- Without `E2E_X402` the e2e run is unchanged.

## 3. Internal security review (26 Nov 2026)

An independent reviewer read the code and found no path for escrowed funds other than forward or refund, and no
double settlement. Each server finding and what was done:

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | A replay of the public funding calldata could confirm a guessed prompt (2xx vs 409). | Medium | **Fixed**: every replay answers one uniform `409 payment_used`, with no job id and no body comparison. |
| 2 | Settlement depended on the live config, so switching off or changing the escrow address stranded escrows. | Medium | **Fixed**: settlement runs while open rows exist and uses each row's stored escrow and asset; secret polling keeps working. |
| 3 | Unknown funding outcomes were misread (a send error counted as "not sent"; a stale row was marked failed while the transaction could still land; the timer raced the paying request). | Medium | **Fixed**: only a failed simulation or a mined revert is final. A stale row is resolved from the chain (escrow held: refund; authorization unused after `validBefore`: failed; used elsewhere: failed with a surplus note). In-flight rows are skipped, and the held update is conditional. |
| 4 | No nonce management for the shared scheduler key. | Medium | **Fixed**: `sendAsScheduler` in `chain-io.ts` serializes every scheduler-key broadcast (root post, charge, escrow calls). |
| 5 | Anyone could use up a job's poll quota with wrong secrets. | Low/Medium | **Fixed**: the secret is checked first, wrong secrets count per IP, and only x402 jobs accept secrets on these routes. |
| 6 | Gas griefing (fund + refund per bad job) and RPC reads for anyone. | Low | **Partly fixed**: one funding in flight per payer (a unique index), a per-IP limit on payment attempts before any chain read, and the caps. **Open**: `X402_PRICE_PER_UNIT` must cover two scheduler transactions per job. |
| 7 | A leaked authorization could be submitted to the token directly. | Low | **Fixed/documented**: `validBefore` ≤ now + `maxTimeoutSeconds` + 60 s, and the facilitator URL stays unset on mainnet. The surplus is returned by the Safe via `recoverSurplus` (tested). |
| 8 | An error after payment lost the one-time read secret. | Low | **Fixed**: after queueing, the answer is always `202` with the secret. |
| 9 | Timing can link a payer to a job in the public list. | Low | **Documented** (docs page "Trust"). |
| 10 | No startup consistency checks. | Low/Info | **Fixed**: the preflight described in 2.2. |
| Info | The scheduler key alone decides forward vs refund. The Safe plus the scheduler can redirect the pot share via `setForwardTo`. | | **Documented** (docs page "Trust" / "Limits"). |

## 4. Deploy (not done here)

**Script:** `contracts/script/DeployX402Escrow.s.sol`.
- Addresses come from env and from `contracts/mainnet.json` (`treasury.safe`); none is guessed.
- On chain 4663 the script requires that:
  - owner, treasury and forwardTo are contracts;
  - the owner is the reward contract's owner;
  - the asset's `DOMAIN_SEPARATOR` matches the configured name and version;
  - the asset answers `authorizationState`.

**Commands**, from `contracts/`, with the deployer keystore:

```sh
export REWARD_CONTRACT=0x68A0569130551154FC1aABD71d99f65681c58Fe9          # src/lib/addresses.ts ADDR.rewards
export X402_ASSET=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168               # USDG, verified in 1.3
export X402_ASSET_NAME="Global Dollar" X402_ASSET_VERSION=1
export X402_MAX_PER_JOB=[X402_MAX_PER_JOB] X402_MAX_TOTAL_HELD=[X402_MAX_TOTAL_HELD] X402_MAX_PER_PAYER_PER_EPOCH=[X402_MAX_PER_PAYER_PER_EPOCH]
# optional: X402_FORWARD_TO (default: the treasury Safe), X402_SETTLE_WINDOW (default 43200)
node tools/forge.mjs script script/DeployX402Escrow.s.sol --rpc-url robinhood --sender 0x6C079ff20B77fBbc89Fb5C90c5f43Cf24166d7D4            # dry-run
node tools/forge.mjs script script/DeployX402Escrow.s.sol --rpc-url robinhood --account sparecycle-mainnet --broadcast   # deploy
```

**Proposed parameters** (Default, not yet confirmed by Fabio):

| Parameter | Value | Why |
| --- | --- | --- |
| `X402_SETTLE_WINDOW` | 43,200 s | The 6 h job TTL plus 6 h. |
| `X402_MAX_PER_JOB` | 5 USDG (`5000000`) | |
| `X402_MAX_TOTAL_HELD` | 500 USDG (`500000000`) | |
| `X402_MAX_PER_PAYER_PER_EPOCH` | 50 USDG (`50000000`) | |
| `X402_FORWARD_TO` | the treasury Safe | A separate Safe-owned converter is cleaner, but none exists yet. |
| `X402_PRICE_PER_UNIT` | **TBD** | Must cover the gas of two scheduler transactions per job. |

**Dry-run.**
- **Local:** passed. The script ran in-process on local mocks for chain 31337, and for chain 4663 with the mainnet guards (`test/DeployX402Escrow.t.sol`). It printed the deployed address, wiring and caps, and the read-back matched.
- **Against a mainnet fork:** not run in this session. It was refused as a production deploy by the session's permission rules. Run the dry-run command above first: without `--broadcast` forge only simulates.

**After deploy:**
1. Verify the source on Blockscout and Sourcify.
2. Add the address to `src/lib/addresses.ts` and `/docs/contracts`.
3. Set `X402_*` on the scheduler, restart, and check the log line `x402 on (INTERNAL REVIEW ONLY …)` and that there is no preflight error.
4. Test one small payment end to end.

## 5. What still blocks a public launch, and the risks

**Blocks a public launch:**
- Fabio's confirmation of A13 and A14.
- The legal review of the paid surface (the spec's counsel review before accepting payments still stands; TBD).
- `X402_PRICE_PER_UNIT`, the caps, `forwardTo` and the conversion procedure.
- The mainnet-fork dry-run.
- Deploy, source verification and the address table.

**Risks:**
- **No external audit.** The caps bound the loss.
- All three treasury Safe keys are held by one person (F2). The Safe sets `forwardTo` and the caps.
- **USDG can be frozen, paused, wiped and upgraded by Paxos:**
  - a frozen payer cannot be refunded until unfrozen;
  - if the escrow itself is frozen, every held escrow is stuck;
  - an upgrade can change EIP-3009 behaviour.
- **Conversion to ETH is manual.** Node operators see the pot share only after the Safe converts and funds it.
- **The scheduler key decides verdicts and settlements.** A stolen key can forward held escrows (to the pot and treasury only, never to itself) or refund them.
- **Payments are public on-chain.** At low volume, timing can link a wallet to a job.
- **Each x402 job costs the scheduler two transactions.** The per-IP limit and the caps bound abuse; the price must cover the gas.
