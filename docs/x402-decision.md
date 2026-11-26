# x402 pay-per-job: decision record (design only)

**Status:** proposed, not decided. Decisions A13 (settlement design) and A14 (payment asset) are **open** with Fabio.
No x402 code is merged before this record is decided. Until then, agents pay through a prepaid wallet balance and an
API key (`/docs/api/keys`, `/docs/api/openai`, `/docs/api/mcp`).

**Recommendation:** **X1**, a new non-custodial pay-per-job escrow contract. **Never X3** (scheduler-held funds).

The x402 specification (the `402` answer, its headers, the payment payload, facilitator settlement) must be read from
the current x402 documentation when this is built. Nothing below depends on a specific x402 version or header name.

## Why x402 does not fit the live payments contract

Facts from `contracts/src/SparecycleJobPayments.sol` and the scheduler code in this repository:

1. **Deposits credit `msg.sender`.** `deposit()` (line 91) and `receive()` (line 96) both call `_deposit(msg.sender, …)`.
   There is no `depositFor(customer)`. If a facilitator or the scheduler submitted an agent's payment, the balance would
   be credited to the facilitator or the scheduler, not to the agent. Spending it for the agent would be custody (C1).
2. **ETH only.** The constructor reverts with `NotEthRewards` unless the reward contract pays out in ETH (line 81).
   Common x402 schemes rely on signed token authorisations (for example EIP-3009-style transfers). Native ETH has no
   signed-transfer standard. Whether USDG on Robinhood Chain supports one is **not known** (TBD).
3. **The pot cannot refund.** `charge(…)` sends 95% to `rewards.fund()` (line 175) and 5% to the treasury (line 177).
   `fund()` in `SparecycleRewards.sol` only credits the current epoch's pot; there is no refund. Money must not reach the
   pot before two nodes agree, so a pay-before-work flow needs a place that holds the payment and gives it back on a
   mismatch.
4. **`402` is already taken.** The scheduler answers `402 insufficient-balance` with a JSON body
   (`src/server/payments.ts:126`, `src/server/jobs.ts`), and the OpenAI-compatible routes answer
   `402 insufficient_balance`. An x402 `402` must be told apart by the headers the x402 spec defines and a different
   error code.

Not a blocker, for the record: `@x402/*` packages are **not installed**. They appear in `package-lock.json` only as
optional peer dependencies of `@coinbase/cdp-sdk`, which `next.config.ts` aliases to a local stub.

## Options

| | X1. Per-job escrow contract | X2. New payments contract with `depositFor` | X3. Scheduler-held funds |
| --- | --- | --- | --- |
| How it works | Accepts a signed payment for one job id and holds it. On `agreed`: forwards 95% to `rewards.fund()` and 5% to the treasury. On `released` (results did not match, expired, rejected): refunds the payer. | An x402 payment tops up the agent's own prepaid balance through `depositFor(customer)`; the normal per-epoch charge then applies, like today. | The scheduler receives payments and spends them for the agent. |
| Payment asset | Needs an asset with signed transfers (USDG or another token, **TBD**, A14). Native ETH cannot be pulled with a signature. | Same: a token path for signed payments is still needed. | Any, which is what makes it tempting. |
| Refund path | Built in: the escrow refunds the payer on `released`; nothing reaches the pot before agreement. | The balance stays the agent's and is withdrawable like today (two-step withdrawal); nothing is charged for jobs that do not agree. | The scheduler would have to send refunds itself. |
| Custody | **Non-custodial**: funds sit in a contract whose only outcomes are "forward on agreement" or "refund". | **Non-custodial** for the balance, but the payment asset must be accepted by the payments contract, which today is ETH-only. | **Custodial**: conflicts with C1. **Not recommended.** |
| Contract work | New contract; the live contracts stay unchanged. | New payments contract next to the live one: two payments contracts, a migration and UI questions. | None on-chain, which hides the custody. |
| Size | Largest; cleanest. | Large. | Not an option. |

## Decision asked of Fabio

1. **A13:** adopt **X1** as the design for x402 pay-per-job. Reject X3 permanently.
2. **A14:** choose the payment asset. Before choosing, verify on-chain (read the token contract, not a website) whether
   USDG on Robinhood Chain supports a signed-transfer standard, and which facilitators support that chain and asset.
   Record the token address only after it is verified.
3. Legal review of the paid surface before accepting payments this way (the spec's note on counsel review before
   accepting deposits still stands; TBD).

## X1 outline (for the build after the decision)

- Escrow state per job id: payer, amount, asset, deadline, and one terminal outcome (forwarded or refunded).
- Only the scheduler key (`rewards.scheduler()`) can settle; settlement is "forward" for an agreed job and "refund" for
  a released one. After the deadline (the job TTL plus a margin), anyone can trigger the refund, so a stuck scheduler
  cannot keep funds.
- The forward path splits like `charge()` today: 95% into the reward pot, 5% to the treasury. If the payout asset is not
  the escrow asset, the forward path is undefined until a conversion rule is decided; X1 with a non-ETH asset is
  therefore tied to the payout-asset decision as well.
- Off-chain: the scheduler answers an x402 `402` with the job's quoted price (the same `jobPriceWei` rule) and the
  escrow details, accepts the signed payment through a facilitator or directly, queues the job only after the escrow
  holds the payment, and settles on the verdict. The per-job record goes into the epoch's published charge list.

## Audit plan (X1)

- Foundry unit and invariant tests: every escrowed payment ends forwarded or refunded exactly once; no path sends funds
  anywhere else; refund after the deadline works without the scheduler; reentrancy on forward and refund.
- A fork test against the live reward contract and treasury on Robinhood Chain (no state change on mainnet).
- An external audit before deployment, then source verification on the explorer and an entry in the docs address table.
- A capped launch (per-job and total escrow limits) until the audit findings are closed.

## Not in this record

- No x402 code, no new dependency, no change to any deployed contract.
- No address, price, fee, date or partnership is stated here; every such value stays TBD until verified.
