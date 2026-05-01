# Internal Review

This document records a structured walkthrough of the Redoubt Anchor program performed by the developer in a single session. Use this document as a record of what was checked and what was found.

## Scope

In scope (read line-by-line):

- All instruction handlers in `programs/redoubt/src/instructions/`
- All account state structs in `programs/redoubt/src/state/`
- Error definitions (`errors.rs`)
- Module wiring (`lib.rs`, `instructions/mod.rs`)

Out of scope:

- The TypeScript test suite (verified passing; not reviewed for completeness)
- Build configuration, toolchain pinning, and CI

## Methodology

Each instruction was checked for:

- **Authorization** — signer requirements, `has_one` constraints, custom auth checks
- **State preconditions** — required `BountyStatus`, `EscrowType`, account ownership
- **Account validation** — PDA seed derivation, `mut` / `close` constraints
- **Arithmetic safety** — overflow / underflow, `checked_*` operations
- **Funds movement** — escrow drains route to the correct party, in the correct amount
- **Pause coverage** — gated where it should be, deliberately not gated where existing bounties need to resolve
- **Reputation handling** — when counters increment, who pays for `init_if_needed`
- **CPI correctness** — signer seeds, PDA-as-signer
- **Race conditions and griefing vectors** — front-running, cranking incentives, denial of resolution
- **Reentrancy and atomicity** — single-tx state mutation safety

The checklist was applied to each handler in isolation, then to cross-cutting concerns (FSM integrity, escrow accounting, init-if-needed safety).

## Findings

Severity is assigned conservatively — borderline items are tagged the higher of the two plausible levels. Where a finding represents an intentional design tradeoff rather than a bug, it is noted as such and given a severity reflecting the operational risk of that tradeoff.

### High

#### H-01 — `initialize_config` is callable by anyone before first init

`instructions/initialize_config.rs` — the singleton `Config` PDA is created via Anchor's `init` constraint. The first caller becomes `admin` and sets `guardian`. There is no onchain check that the caller is the program's deploy authority, the program's upgrade authority, or any pre-committed pubkey.

**Risk:** on mainnet, after `solana program deploy` completes but before the deployer's `initialize_config` transaction lands, a third party monitoring the program ID could front-run the deployer and become admin. The deployer would be locked out of admin operations for the lifetime of the program.

**Mitigation (deploy-time, no code change):** include `initialize_config` in the same atomic transaction or transaction bundle as the program deployment. The Solana CLI deploy command does not support this directly, so the deploy script must:

1. Deploy the program (write `redoubt.so`).
2. Immediately, in a follow-up transaction, call `initialize_config` from the intended admin wallet.
3. Verify that `Config.admin` equals the expected pubkey before announcing the deploy.

If front-run, the response is to deploy a new program ID (the old one is now controlled by the front-runner) and start over. There is no recovery in place.

**Mitigation (code change, optional):** make the deploy authority's pubkey a `pub const ADMIN_BOOTSTRAP: Pubkey` and require `caller == ADMIN_BOOTSTRAP` in `initialize_config`. Trades flexibility for safety.

### Medium

#### M-01 — `admin` and `guardian` keys are immutable after initialization

`state/config.rs`, `instructions/initialize_config.rs` — there is no `set_admin` or `set_guardian` instruction. Once `initialize_config` runs, both keys are fixed for the life of the program.

**Risk:** if either key is lost, compromised, or needs to rotate to a multisig, there is no recovery path short of redeploying the program (which abandons all existing bounties' state).

**Tradeoff:** immutability is also a trust-minimization feature — admin cannot quietly hand off control to a different party. For an MVP this might be deliberate. Document it explicitly either way.

**Recommendation:** for a launch with non-trivial TVL, add `set_admin` (admin-signed, with a 24-48 hour timelock) and `set_guardian` (admin-signed). For a smaller launch, document immutability in `SECURITY.md` so users know.

#### M-02 — No event emissions on critical state changes

Across all admin instructions: `initialize_config`, `whitelist_token`, `unwhitelist_token`, `pause`, `unpause` — no `emit!()` macros are present. State changes are only observable by polling.

**Risk:** off-chain monitoring (e.g., for unauthorized admin actions) is harder than it should be. A malicious admin could pause-unpause-pause repeatedly to disrupt service, and the only signal is balance / Config polling.

**Recommendation:** add `emit!()` for: pause, unpause, whitelist_token, unwhitelist_token, initialize_config. Cheap and high-value for incident response.

### Low

#### L-01 — `Agent.is_active` has no deactivation path

`instructions/register_agent.rs` — `is_active` is set to `true` on registration and never modified. The field name implies a toggle, but in practice it's a "registered" check.

**Recommendation:** either rename to `is_registered`, or add a `deactivate_agent` instruction so the field has its implied semantics.

#### L-02 — `Agent.is_verified` reserved but never set

`state/agent.rs` — the field is initialized to `false` and never changed. External integrations might assume it's a meaningful signal.

**Recommendation:** either implement a verification flow or remove the field.

#### L-03 — `Agent.did_uri` immutable after registration

`instructions/register_agent.rs` — there is no `update_agent_did` instruction. Agents cannot update their DID URI without re-registering (which is blocked by the existing PDA).

**Recommendation:** add `update_agent` (signed by `wallet`) that allows changing `did_uri`. Trivial addition.

#### L-04 — `metadata_uri` and `namespace` length-checked but not non-empty

`instructions/create_bounty.rs`, `create_bounty_spl.rs` — both fields can be empty strings. `submit_work` does require a non-empty `submission_uri`, so the asymmetry is inconsistent.

**Recommendation:** add `require!(!metadata_uri.is_empty(), ...)` and similarly for namespace, or document that empty values are intentional.

#### L-05 — Permissionless expire instructions have no incentive

`instructions/expire_bounty.rs`, `expire_submitted.rs` — `caller` pays transaction fees but receives nothing. In practice, expire_bounty's incentive is the creator (who wants their refund), and expire_submitted's incentive is the claimer (who wants their reward) — but neither is guaranteed to crank.

**Risk:** in pathological cases, an expired bounty could sit unresolved indefinitely if neither party cranks.

**Recommendation:** consider a small SOL bounty paid to `caller` from the escrow on successful expiry — say 0.001 SOL. Adds incentive without meaningfully eating reward.

#### L-06 — `SUBMISSION_GRACE_SECONDS` hardcoded to 7 days

`state/bounty.rs` — the grace window before `expire_submitted` becomes callable is a const. Changing it requires a code upgrade.

**Recommendation:** acceptable as-is for MVP; revisit if real-world usage shows 7 days is wrong, and consider moving to `Config` then.

#### L-07 — Reputation init cost falls on the caller

`approve_bounty`, `approve_bounty_spl`, `expire_submitted`, `resolve_dispute` — all use `init_if_needed` for both creator and claimer reputation PDAs, with `payer = creator` (or `caller` in `expire_submitted`, `admin` in `resolve_dispute`).

**Risk:** the first time a wallet is touched by an Approved transition, the bounty's resolution costs an extra ~0.0028 SOL (2 × rent for a 65-byte account). For high-value bounties this is invisible; for low-value bounties (<1 SOL reward) it's noticeable.

**Recommendation:** acceptable as-is. Worth documenting.

#### L-08 — `resolve_dispute(AwardClaimer)` can pay claimers without submitted work

`instructions/resolve_dispute.rs` — admin can force-pay a claimer when bounty is in `Claimed` state (claimer claimed but never submitted). This is by design — admin override needs to be powerful enough to resolve genuinely stuck bounties — but it's a power that could be misused.

**Recommendation:** acceptable for MVP; document explicitly. Consider requiring a non-empty `submission_uri` for the AwardClaimer path in v2.

### Informational

#### I-01 — Donations to escrow PDA flow to creator on close

`approve_bounty`, `expire_submitted`, `resolve_dispute` — escrow lamports are split: `reward_amount` goes to claimer, the remainder (rent + any donations) goes to creator via Anchor's `close = creator`. If a third party transfers extra SOL to the escrow PDA before resolution, that SOL ends up with the creator.

Behavior, not a bug. Worth knowing for downstream tooling.

#### I-02 — `AwardClaimer` from `Claimed` produces `Approved` with `submitted_at = 0`

`instructions/resolve_dispute.rs` — when admin force-pays a claimer who never submitted, the resulting bounty has `status = Approved` but `submitted_at = 0`. Consumers reading the bounty post-resolution should not assume `submitted_at > 0` implies submission occurred.

#### I-03 — Bounty IDs are creator-supplied; collision is prevented by PDA init

`instructions/create_bounty.rs`, `create_bounty_spl.rs` — `bounty_id` is part of the seed. Creating two bounties with the same `(creator, bounty_id)` would fail at the second `init` because the PDA already exists. No special handling required.

#### I-04 — SPL approve: creator pays for claimer's ATA init if absent

`instructions/approve_bounty_spl.rs` — `claimer_token_account` uses `init_if_needed` with `payer = creator`. If the claimer doesn't already have an ATA for the bounty's mint, creator pays the rent (~0.002 SOL) on top of the bounty reward. Acceptable; worth knowing.

## Things considered and not flagged

The following were checked and found acceptable:

- **FSM integrity** — every instruction's status preconditions and updates were cross-checked against the documented state machine. No unreachable transitions; no missing terminal-state guards. `BountyAlreadyResolved` and the per-instruction status checks combine to prevent double-resolution.
- **Escrow accounting** — SOL escrow uses `try_borrow_mut_lamports` with `checked_sub` / `checked_add` and an `EscrowUnderfunded` guard. SPL escrow uses Token program CPIs with PDA signer seeds derived correctly. Both close the escrow PDA via Anchor's `close = creator`, returning rent.
- **PDA bump storage** — every PDA struct stores its bump and uses `bump = ...bump` in subsequent constraints, preventing seed-canonicalization issues.
- **Reentrancy** — Solana does not allow a program to re-enter itself within a single transaction; state mutations occur before any CPIs that could plausibly attempt re-entry.
- **`init_if_needed` safety on `AgentReputation`** — counters are monotonic and saturating; PDA seeds are wallet-scoped and cannot collide; `init_if_needed`'s reinit-attack class does not apply.
- **Pause coverage** — gating on `create_bounty`, `create_bounty_spl`, and `claim_bounty` blocks new economic commitment; resolution paths (submit, approve, cancel, expire, resolve) are deliberately not gated, ensuring funds cannot be trapped by pause.
- **Cross-type rejection** — every SOL handler rejects SPL bounties and vice versa via `WrongEscrowType`. No way to invoke SOL-shaped logic on an SPL escrow.
- **Signer seeds for SPL CPIs** — `approve_bounty_spl` and `cancel_bounty_spl` derive the escrow PDA's signer seeds from the stored bump and use `CpiContext::new_with_signer`. Verified seeds match the PDA derivation.
- **Whitelist enforcement** — `create_bounty_spl` requires the `TokenWhitelist` PDA derived from the mint as an account argument. Anchor's deserialization fails for any mint without an existing whitelist PDA.
- **Pause authorization asymmetry** — `pause` is callable by admin OR guardian; `unpause` is admin-only. Correct for an emergency-stop pattern.
- **Bounty parameter validation** — `reward_amount > 0`, `deadline > now`, URI lengths are all checked at the top of `create_bounty` and `create_bounty_spl`.

## Conclusion

This single-session walkthrough surfaced findings that are predominantly design tradeoffs and operational considerations rather than critical bugs in the core escrow or FSM logic. The program follows standard Anchor patterns; account validation, signer requirements, and arithmetic safety are correctly applied across the instruction surface.

The most important finding is **H-01** — `initialize_config` front-running — which is a deploy-time process concern rather than a code defect. The remaining medium-severity items concentrate around admin key management (M-01) and operational visibility (M-02). Most are resolvable with small targeted additions in a follow-up release.

This review should not be cited as evidence of security.
