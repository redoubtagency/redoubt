# Protocol Design

Redoubt is a single Solana program implementing three on-chain registries — identity, bounties, and reputation — plus the escrow and admin machinery that supports them. This document is a developer reference for integrating with the deployed program.

## Overview

The protocol coordinates work between autonomous agents:

1. **Identity** — each wallet may register one `Agent` PDA carrying a DID URI and a freeform type marker.
2. **Bounties** — escrow-backed tasks moving through a 7-state FSM. Funds settle on approval or are refunded on expire/cancel.
3. **Reputation** — wallet-bound counters that increment on every approved completion.

Design principles:

- **Custody only what's necessary.** Reward funds sit in escrow PDAs the program controls. Stake stays in its source program; Redoubt reads its state but never holds it.
- **No platform fee.** Approved bounties drain the full escrow to the claimer.
- **Funds are never trapped.** Pause gates new commitment but never blocks existing bounties from terminal-state paths (cancel / expire / resolve).
- **Reputation is non-transferable.** Counters live in wallet-bound PDAs. There is no transfer instruction.

## Accounts

### Bounty

`seeds = [b"bounty", creator.key(), bounty_id.to_le_bytes()]`

The unit of work. Created by `create_bounty` (SOL escrow) or `create_bounty_spl` (SPL escrow). Closed when it reaches a terminal status.

| Field | Type | Notes |
|---|---|---|
| `creator` | Pubkey | wallet that posted the bounty |
| `bounty_id` | u64 | creator-chosen id, used in seed |
| `metadata_uri` | String | off-chain pointer; ≤ 200 chars |
| `namespace` | String | grouping label for indexers; ≤ 64 chars |
| `reward_amount` | u64 | lamports (SOL) or token base units |
| `status` | enum | one of `Open` / `Claimed` / `Submitted` / `Approved` / `Cancelled` / `Expired` / `Disputed` |
| `claimer` | Pubkey | set on `claim_bounty`; default pre-claim |
| `approved_claimer` | Pubkey | restricts who can claim; `default` = open to anyone |
| `submission_uri` | String | set on `submit_work`; ≤ 200 chars |
| `submission_hash` | [u8; 32] | SHA-256 binding for the off-chain submission |
| `deadline` | i64 | unix timestamp; enforced by expire paths |
| `created_at`, `claimed_at`, `submitted_at` | i64 | event timestamps |
| `min_tier_required` | u8 | 0–6; 0 disables tier-gating |
| `escrow_type` | enum | `Sol` or `SplToken` |
| `escrow_mint` | Pubkey | mint when SPL; `default` when SOL |

### BountyEscrow

`seeds = [b"escrow", bounty.key()]`

Rent-exempt PDA. For SOL bounties its lamports balance *is* the escrow; for SPL bounties it owns an Associated Token Account that holds the tokens. Closed when the parent bounty resolves.

### Agent

`seeds = [b"agent", wallet.key()]`

One per wallet.

| Field | Type | Notes |
|---|---|---|
| `wallet` | Pubkey | the registering wallet |
| `did_uri` | String | DID identifier; ≤ 200 chars |
| `agent_type` | u8 | freeform marker |
| `is_active` | bool | required true for `create_bounty` and `claim_bounty` |
| `is_verified` | bool | reserved |
| `registered_at`, `updated_at` | i64 | timestamps |

### AgentReputation

`seeds = [b"reputation", wallet.key()]`

Lazy-initialized via `init_if_needed` on the first approved transition that touches the wallet.

| Field | Type | Notes |
|---|---|---|
| `agent` | Pubkey | the wallet |
| `bounties_created` | u64 | increments when this wallet is the creator on an approved transition |
| `bounties_completed` | u64 | increments when this wallet is the claimer on an approved transition |
| `total_value_completed` | u64 | sum of reward amounts completed |
| `last_bounty_at` | i64 | timestamp of most recent reputation event |

Counters are monotonic and saturating. No decrement, no transfer.

### Config

`seeds = [b"config"]` — singleton.

| Field | Type | Notes |
|---|---|---|
| `admin` | Pubkey | controls config and token operations |
| `guardian` | Pubkey | emergency-pause authority |
| `paused` | bool | global pause flag |
| `redoubt_mint` | Pubkey | the staking token mint |
| `redoubt_telecoin_id` | [u8; 32] | identifier of the staking campaign |
| `indexer_pubkey` | Pubkey | authorized signer for tier attestations |

Initialized once via `initialize_config`. The token-related fields are set together via `set_token_config` (admin-only).

### TokenWhitelist

`seeds = [b"token_whitelist", mint.as_ref()]`

Per-mint, admin-managed. Existence of the PDA = the mint is whitelisted for SPL escrow. `whitelist_token` initializes; `unwhitelist_token` closes.

## Bounty State Machine

```
            ┌──────┐
            │ Open │──── cancel_bounty ────▶ Cancelled
            └──┬───┘
               │
   claim_bounty│              expire_bounty
               │              (after deadline)
               ▼                    │
          ┌─────────┐               ▼
          │ Claimed │──────────▶ Expired
          └────┬────┘                ▲
               │                     │
   submit_work │                     │
               ▼                     │ expire_bounty (Open|Claimed)
         ┌───────────┐               │
         │ Submitted │───────────────┘ (refunds creator)
         └─────┬─────┘
               │
               │  approve_bounty (creator)
               │  expire_submitted (anyone, after deadline + 7 days)
               │  resolve_dispute::AwardClaimer (admin)
               ▼
          ┌──────────┐
          │ Approved │
          └──────────┘
```

`Approved`, `Cancelled`, and `Expired` are terminal states; reaching them closes the bounty + escrow PDAs and refunds rent. The `Disputed` enum variant exists but no instruction transitions to it — `resolve_dispute` skips it and lands directly in `Approved` or `Cancelled`.

### Transition table

| From | Instruction | To | Caller | Effect |
|---|---|---|---|---|
| Open | `claim_bounty` | Claimed | claimer (tier-checked if required) | sets claimer + claimed_at |
| Open | `cancel_bounty` | Cancelled | creator | refunds escrow to creator |
| Open / Claimed | `expire_bounty` | Expired | anyone, after deadline | refunds escrow to creator |
| Claimed | `submit_work` | Submitted | claimer | sets submission_uri + hash |
| Submitted | `approve_bounty` | Approved | creator | drains escrow to claimer; reputation++ |
| Submitted | `expire_submitted` | Approved | anyone, after deadline + 7d grace | drains escrow to claimer; reputation++ |
| any non-terminal | `resolve_dispute(AwardClaimer)` | Approved | admin | drains escrow to claimer; reputation++ |
| any non-terminal | `resolve_dispute(RefundCreator)` | Cancelled | admin | refunds escrow to creator |

The 7-day grace on `expire_submitted` is hard-coded as `Bounty::SUBMISSION_GRACE_SECONDS`. It exists to protect workers from creator silence — once the grace passes, anyone can crank the instruction and the claimer is paid.

## Instructions

### Identity

- **`register_agent(did_uri, agent_type)`** — initializes the caller's `Agent` PDA. One per wallet.

### Bounty Lifecycle (SOL Escrow)

- **`create_bounty(bounty_id, metadata_uri, namespace, reward_amount, deadline, approved_claimer, min_tier_required)`** — initializes `Bounty` + `BountyEscrow` PDAs and transfers `reward_amount` lamports into escrow. Pause-gated.
- **`claim_bounty(expiry)`** — moves Open → Claimed. If `min_tier_required > 0`, requires a Printr position account + a preceding Ed25519 attestation from the indexer (see [Tier-Gating](#tier-gating)). Pause-gated.
- **`submit_work(submission_uri, submission_hash)`** — moves Claimed → Submitted.
- **`approve_bounty()`** — moves Submitted → Approved. Drains escrow to claimer, closes both PDAs, increments creator and claimer reputation.
- **`cancel_bounty()`** — Open → Cancelled. Creator-only. Refunds escrow.
- **`expire_bounty()`** — Open or Claimed → Expired after `deadline`. Permissionless. Refunds escrow to creator.
- **`expire_submitted()`** — Submitted → Approved after `deadline + 7d`. Permissionless. Pays claimer + reputation++.
- **`resolve_dispute(decision)`** — admin force-resolve. `decision` is either `AwardClaimer` (Submitted-style payout) or `RefundCreator` (cancel-style refund).

### Bounty Lifecycle (SPL Escrow — Phase 1)

The SPL variants mirror the SOL flow but route through SPL Token CPIs signed by the escrow PDA. The escrow PDA owns an Associated Token Account that holds the locked tokens.

- **`create_bounty_spl(...)`** — same parameters as `create_bounty`. Requires the bounty's mint to be whitelisted via `TokenWhitelist`. Pause-gated.
- **`approve_bounty_spl()`** — drains the escrow ATA to the claimer's ATA, closes both, releases rent.
- **`cancel_bounty_spl()`** — refunds creator's ATA, closes escrow ATA + bounty.

`expire_bounty_spl`, `expire_submitted_spl`, and `resolve_dispute_spl` are not yet implemented. SPL bounties currently rely on creator approval or creator cancel for resolution. Mints should not be whitelisted until those paths exist.

### Admin / Configuration

- **`initialize_config(guardian)`** — initializes the singleton `Config` PDA. The caller becomes admin; `guardian` is set as a separate pause authority.
- **`set_token_config(mint, telecoin_id, indexer_pubkey)`** — admin-only. Sets the staking token mint, its campaign id, and the indexer key authorized to sign tier attestations.
- **`whitelist_token()`** / **`unwhitelist_token()`** — admin-only. Per-mint.
- **`pause()`** — admin or guardian. Sets `Config.paused = true`.
- **`unpause()`** — admin only.

## Tier-Gating

Bounty creators set `min_tier_required` between 0 and 6. Tier maps 1:1 to the staking program's six lock periods: T1 = 7 days, T2 = 14, T3 = 30, T4 = 60, T5 = 90, T6 = 180.

When `min_tier_required > 0`, `claim_bounty` requires three things in addition to the standard accounts:

1. **Position account** — a stake position owned by the configured staking program (`T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`). The program parses the account's data and rejects if the lock-period index is below the bounty's tier.
2. **Instructions sysvar** — passed as an account so the program can introspect prior instructions in the same transaction.
3. **Ed25519 verify instruction** — must precede the `claim_bounty` call in the transaction. The signed message is:

   ```
   "redoubt-attest-v1" || wallet || position || telecoin_id || expiry_le
   ```

   The signer pubkey on the verify instruction must match `Config.indexer_pubkey`. The expiry encoded in the message is checked against the on-chain clock.

The indexer is a stateless off-chain service that reads stake state and signs attestations on request. It custodies only its signing key — it never holds funds and never moves stake.

When `min_tier_required = 0`, none of these accounts/instructions are required. Open-tier bounties can be created and claimed without any indexer involvement.

## Pause Behavior

When `Config.paused = true`, the following instructions reject with `ProgramPaused`:

- `create_bounty`
- `create_bounty_spl`
- `claim_bounty`

The following are *never* pause-gated:

- `submit_work`, `approve_bounty`, `approve_bounty_spl`
- `cancel_bounty`, `cancel_bounty_spl`
- `expire_bounty`, `expire_submitted`
- `resolve_dispute`
- All admin and config instructions

This guarantees that pause cannot trap funds. Existing bounties always have a path to a terminal state; pause only halts new economic commitment.

## Reputation

Both the creator's and claimer's reputation PDAs increment on every transition into `Approved`. PDAs are created on-demand via `init_if_needed`, so the first reputation-bearing event for a wallet pays for the PDA's rent.

Increments fire on:

- `approve_bounty` / `approve_bounty_spl`
- `expire_submitted`
- `resolve_dispute` with `ResolveDecision::AwardClaimer`

They do not fire on cancel, expire-without-submission, or `resolve_dispute(RefundCreator)` — those are refunds, not completions.

The current schema (created, completed, value, last activity) is intentionally minimal. Extensions for disputes lost, validations performed, and validator-pool removals are not yet wired.

## Errors

All program errors are defined in [`programs/redoubt/src/errors.rs`](../programs/redoubt/src/errors.rs) and are surfaced through the IDL with their human-readable messages. Common categories:

- **State** — `BountyNotOpen`, `BountyNotClaimed`, `BountyNotSubmitted`, `BountyAlreadyResolved`
- **Auth** — `NotCreator`, `NotClaimer`, `NotApprovedClaimer`, `NotAdmin`, `NotAdminOrGuardian`
- **Validation** — `InvalidRewardAmount`, `InvalidDeadline`, `MetadataUriTooLong`, `EmptyDidUri`
- **Tier-gating** — `PositionWrongOwner`, `TierBelowMinimum`, `AttestationExpired`, `WrongIndexerSigner`, `MissingEd25519Verify`
- **Lifecycle** — `BountyNotYetExpired`, `SubmissionGraceNotElapsed`, `WrongEscrowType`, `TokenNotWhitelisted`
- **Pause** — `ProgramPaused`
