# Multisig runbook: reward-contract owner and treasury Safe

Who controls what on Robinhood Chain mainnet (4663), how the owner moves to a Safe, and what the signers do afterwards.
Values in `[BRACKETS]` are decisions that are still open (see "Open decisions"). Nothing here is sent by a script on
its own: every mainnet transaction is signed by a person.

## Done on mainnet, 25 Nov 2026

The cut-over below was carried out with option A (the treasury Safe is the owner). All three signers are held by the
project owner, so the brief's "no single person controls the threshold" is **not** met yet; swapping one signer for an
independent person later is one Safe transaction (Settings → Setup → Manage signers) and needs no owner move.

| Step | Transaction | Checked |
| --- | --- | --- |
| Treasury Safe signers: `swapOwner(0x6C07…d7D4 → 0xf185…54Ab)` + `addOwnerWithThreshold(0x310e…E22E, 2)` | [`0x5082b606…`](https://robinhoodchain.blockscout.com/tx/0x5082b606238c7fdfaf1aafcfa42b7726200664da84769e2105b22f45270e4c3d), block 122,925,235 | `getThreshold()` = 2, `getOwners()` = `0x310e38F441296070a73549176Df3ED1c3d80E22E`, `0xf185f003840C35c6D3568F414038C7b648d854Ab`, `0x783435E47AcE1905C1197b1d36526797d3dbE696` |
| `transferOwnership(Safe)` from the launch wallet (`node scripts/mainnet.mjs transfer-owner`) | [`0xeafcacd3…`](https://robinhoodchain.blockscout.com/tx/0xeafcacd3cdb3f50445ff6cace234756c9f21990a7d0def014eab64596afdb5a0), block 122,931,018 | `pendingOwner()` = the Safe |
| `acceptOwnership()` as a Safe transaction (2 of 3 signatures) | [`0x49470d49…`](https://robinhoodchain.blockscout.com/tx/0x49470d4978f9ee6ff73a6d339c06a876fe98b5bcf20ad3c8287eccf14bdc4346), block 122,955,386 | `owner()` = the Safe, `pendingOwner()` = 0; `setScheduler` / `pauseClaims` from `0x6C07…d7D4` revert `OwnableUnauthorizedAccount` |

Notes from the run: a phone wallet on an ISP that blocks the Robinhood RPC could neither sign nor execute in Safe{Wallet}
directly; signing through WalletConnect from the laptop worked, and a fully signed Safe transaction can be executed by
any account with gas (here the launch wallet).

The sections below are the plan as written before the move; "Roles today" describes the state before it.

## Roles before the move (read on chain, 25 Nov 2026, morning)

| Role | Address | Powers |
| --- | --- | --- |
| `SparecycleRewards` | [`0x68A0569130551154FC1aABD71d99f65681c58Fe9`](https://robinhoodchain.blockscout.com/address/0x68A0569130551154FC1aABD71d99f65681c58Fe9) | Epoch pot, Merkle claims. No withdraw function. |
| Owner (cold) | `0x6C079ff20B77fBbc89Fb5C90c5f43Cf24166d7D4`, one wallet | `setScheduler`, `pauseClaims` / `unpauseClaims`, `rescueToken` (never the payout asset), `transferOwnership`. `renounceOwnership` is disabled. |
| Scheduler (hot) | `0xc062625d4bD24bcE5C8b62F950A38C962CF240B6` | `closeEpochAndPostRoot` every 6 h, and `SparecycleJobPayments.charge` (it checks `msg.sender == rewards.scheduler()`). |
| Treasury Safe | [`0xb262E4436aD6760F91e987f14e2fAc5D6550c71B`](https://robinhoodchain.blockscout.com/address/0xb262E4436aD6760F91e987f14e2fAc5D6550c71B), Safe 1.5.0, 2 of 2 | Receives 5% of every job charge. Fixed (`immutable`) in `SparecycleJobPayments`: it can only be fixed in place, by changing its signers. |
| Treasury signers | `0x6C079ff2…d7D4`, `0x783435E4…E696` | Both on one laptop (separate seed phrases). `0x6C07…d7D4` is also the reward-contract owner and the Pons launcher. |

So one person and one device control the owner and the treasury today. The owner move needs **no contract change and
no redeploy**: the scheduler is a separate role, so epochs keep closing every 6 h through and after the move.

## Tooling

- Safe{Wallet} supports both chains: https://app.safe.global (mainnet short name `robinhood`, testnet `robinhood-testnet`),
  transaction service `https://api.safe.global/tx-service/robinhood`. Treasury:
  https://app.safe.global/home?safe=robinhood:0xb262E4436aD6760F91e987f14e2fAc5D6550c71B
- `node scripts/mainnet.mjs transfer-owner <safe>`: step 1 of the move from the owner wallet (simulates, then asks for
  the word `OWNER` and the keystore password). Uses `contracts/script/TransferOwnership.s.sol`.
- `node scripts/multisig-rehearsal.mjs`: the full move on testnet with a throwaway Safe; log in
  [`multisig-rehearsal.md`](multisig-rehearsal.md).
- `FORK_TESTS=1 FORK_RPC_URL=<rpc> forge test --match-path test/fork/OwnershipFork.t.sol` (in `contracts/`): the move
  simulated on a mainnet fork against the live contract.

## Target

- **2-of-3**, and no single person or device holds two signers: `[LAPTOP_KEY]` (one of today's two), `[HARDWARE_KEY]`
  (a hardware wallet kept apart from the laptop), `[SIGNER_3]` (an independent person, or a second hardware device in
  another place).
- **Option A (recommended): one Safe.** The treasury Safe also becomes the reward-contract owner. **Option B:** a second
  "admin" Safe with the same policy owns the reward contract. `[OPTION]`

## The cut-over, in order

Do it in one sitting. Each step names who acts.

### 1. Fix the treasury Safe's signers (Safe signers, 2 of 2 today)

In Safe{Wallet}: Settings → Setup → Signers. Two Safe transactions, each signed by both current signers:

1. **Add signer** `[SIGNER_3]`, threshold **2**. On chain: `addOwnerWithThreshold([SIGNER_3], 2)` on the Safe itself.
2. **Replace signer** `[KEY_TO_REPLACE]` (one of `0x6C07…d7D4` / `0x7834…E696`) with `[HARDWARE_KEY]`. On chain:
   `swapOwner(prevOwner, [KEY_TO_REPLACE], [HARDWARE_KEY])`; the Safe UI fills in `prevOwner`.

Check: Blockscout → the Safe → Read proxy: `getThreshold()` = 2, `getOwners()` = the three published signers. This
also proves the Safe can sign on chain 4663 before it becomes the owner.

Recommendation: replace `0x6C07…d7D4` (it is also the hot launcher / deployer wallet) rather than `0x7834…E696`.

### 2. Start the transfer (owner wallet `0x6C07…d7D4`)

```
node scripts/mainnet.mjs transfer-owner 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B   # Option A
```

It refuses unless the Safe has code and a threshold of at least 2. Expect event `OwnershipTransferStarted`; after it,
`pendingOwner()` = the Safe and `owner()` is still the wallet.

Rollback before step 3: run it again with the correct address (it overwrites `pendingOwner`). Never use an address
that has not executed a Safe transaction on 4663, and never a counterfactual (not yet deployed) Safe.

### 3. Accept (Safe signers, threshold)

Safe{Wallet} → New transaction → Transaction builder:

| Field | Value |
| --- | --- |
| To | `0x68A0569130551154FC1aABD71d99f65681c58Fe9` |
| Value | `0` |
| Data | `0x79ba5097` (`acceptOwnership()`) |

Expect event `OwnershipTransferred(0x6C07…d7D4, <Safe>)`.

### 4. Check (anyone)

- RPC / Blockscout Read contract on `0x68A0…8Fe9`: `owner()` = the Safe, `pendingOwner()` = `0x0`, `scheduler()` =
  `0xc062…40B6` (unchanged), `claimsPaused()` = false.
- The next 6 h epoch closes on schedule (event `EpochSettled`, visible on `/proof`).
- `node scripts/prelaunch-check.mjs` with `OWNER_ADDRESS` = the Safe passes its owner check.

### 5. Site, config and docs (developer)

| Where | Change |
| --- | --- |
| Railway `web` | `NEXT_PUBLIC_OWNER_ADDRESS` = `NEXT_PUBLIC_MULTISIG_ADDRESS` = `[SAFE]`, redeploy. `src/lib/config.ts` treats the owner as a multisig only when the two are equal; `/legal/disclosures` switches its wording on that. |
| `src/lib/proof.ts` `TREASURY` | `owners: [[SIGNERS]]`, `threshold: [THRESHOLD]`. The live check on `/proof` compares these with `getOwners()` / `getThreshold()`. |
| `contracts/mainnet.json` `treasury` | `owners`, `threshold`, `note` (who holds which key, without names if preferred). |
| README | Overview row and money-flow label "2-of-2" → "[THRESHOLD]-of-[N]"; Roles line "owner (currently a single wallet …)" → "owner = Safe `[SAFE]` ([THRESHOLD]-of-[N])"; Limitations line "The reward contract owner is currently a single wallet, not a multisig." → the Safe, its signer list and a Blockscout link. |
| `docs/SPEC.md` | "Admin = `Ownable2Step` owner (intended: multisig)" → the Safe address and threshold. |

## After the move: what the signers do, and how fast

Target response time: `[RESPONSE_TIME]`. Signer contacts: `[CONTACTS]` (kept off the public repo).

| Situation | Safe transaction (to `0x68A0…8Fe9`, value 0) | Notes |
| --- | --- | --- |
| Scheduler key leaked or lost | `setScheduler(<new key>)` (selector `0x3f6746ce`) | Then set the new key in Railway (`SCHEDULER_SIGNER_KEY`, typed in the dashboard) and redeploy. A leaked scheduler can only affect the **open** epoch's split and charge customers within their balance and spend limit; settled epochs are final. It also gains `charge` rights on `SparecycleJobPayments`, so rotate fast. |
| Wrong root posted / claims must stop | `pauseClaims()` (data `0x0f3314e7`), later `unpauseClaims()` (data `0x3d8f6806`) | Funding and epoch closing continue while claims are paused. |
| A token sent to the contract by mistake | `rescueToken(token, to, amount)` | Reverts for the payout asset (ETH), by design. |
| A signer lost or leaving | On the Safe itself: Replace / Remove signer | Keep 2-of-3, never 3-of-3 (one lost key would freeze the Safe). |

The scheduler key stays hot on the server. Moving the owner does not change what it can do.

## Testnet rehearsal

`node scripts/multisig-rehearsal.mjs` ran the whole sequence on 46630 (fresh reward contract with owner ≠ scheduler,
Safe 1.5.0 2-of-2 → 2-of-3 signer fix, transfer → accept, old owner reverts, Safe rotates the scheduler and pauses,
scheduler still charges and closes). Log with every tx: [multisig-rehearsal.md](multisig-rehearsal.md).

## Open decisions

| # | Decision | Owner |
| --- | --- | --- |
| T1 | `[SIGNER_3]`, `[HARDWARE_KEY]`, which laptop key stays (`[KEY_TO_REPLACE]`), threshold (2 recommended) | Project owner |
| T2 | Option A (treasury Safe = owner) or B (separate admin Safe) | Project owner |
| T5 | `[RESPONSE_TIME]` and how signers are reached | Project owner |

## Housekeeping

`SparecycleJobPayments` (`0x4207…E7eB`) source is an `exact_match` on Sourcify, but Blockscout still shows
"Verify & publish" (an API verification request on 25 Nov 2026 was accepted and did not complete). To finish it:
Blockscout → the contract → Contract → Verify & publish → "Solidity (Standard JSON input)", compiler
`v0.8.28+commit.7893614a`, the JSON from
`forge verify-contract --show-standard-json-input 0x420716931E5Ff2a984840C6E95837d826a8BE7eB src/SparecycleJobPayments.sol:SparecycleJobPayments`
(run in `contracts/`), constructor arguments auto-detected.
