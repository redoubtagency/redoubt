# Security Policy

Redoubt is a Solana program that escrows user funds in bounty PDAs. Read this before using it.

## Status

The program is **unaudited by a third-party firm**. All escrow logic, signature verification, and admin controls have been written by a single developer. A structured walkthrough of the program is published as [`docs/internal-review.md`](docs/internal-review.md) — this is a developer-authored review, not an audit, and is not a substitute for one. The test suite covers the implemented happy paths and a representative set of failure paths.

Use at your own risk. Do not escrow more than you can afford to lose.

## Scope

In scope:

- The Anchor program in `programs/redoubt/`
- Account validation, PDA seed derivation, signer requirements
- SOL and SPL Phase 1 escrow flow
- Tier-gating and indexer attestation verification
- Pause / admin / guardian authorization

Out of scope here:

- Off-chain indexer service (separate codebase)
- The staking program Redoubt reads from
- Wallets, RPC providers, third-party tooling

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

Preferred channel:

- GitHub Security Advisories — open a private advisory at <https://github.com/redoubtagency/redoubt/security/advisories/new>

Backup channel:

- Email: redoubtagency@gmail.com — please include a clear reproducer and an assessment of impact

Reports are acknowledged as soon as practical, typically within a few days. Patch turnaround depends on severity. Coordinated disclosure preferred — please give a reasonable window to ship a fix before public disclosure.

## Bounties

There is no formal paid bug bounty program at this time. Reports that lead to a fix are credited in release notes (or anonymously on request).

## Known limitations

These are documented design tradeoffs, not bugs. The full set with severity tags lives in [`docs/internal-review.md`](docs/internal-review.md); the most user-relevant items are summarized here.

- **SPL escrow is Phase 1.** `expire_bounty_spl`, `expire_submitted_spl`, and `resolve_dispute_spl` are not implemented. SPL bounties resolve only via creator approval or creator cancel — there is no permissionless or admin-driven safety path. **No SPL mints are whitelisted at launch**; the SPL `create` path is unreachable until Phase 2 ships.
- **Validator pool not implemented.** Bounty resolution requires creator approval (Flow A). Validator-mediated approval (Flow B) is deferred.
- **Tier-gating depends on a trusted indexer.** Bounties with `min_tier_required > 0` require an Ed25519 attestation signed by the configured `indexer_pubkey`. A compromised indexer key could grant unauthorized claims on tier-gated bounties. Open-tier bounties (`min_tier_required = 0`) do not depend on the indexer.
- **Admin and guardian are powerful keys.** Admin can change config, whitelist mints, and force-resolve disputes. Guardian can pause new bounty creation and claims. Neither can drain escrows directly, but admin's `resolve_dispute(AwardClaimer)` can redirect a Submitted bounty's escrow to the existing claimer. These keys should be treated as production secrets.
- **Admin and guardian keys are immutable.** There is no `set_admin` or `set_guardian` instruction. If either key is lost or compromised, recovery requires redeploying the program. Verify the admin pubkey onchain before relying on the program.
- **`initialize_config` is unauthenticated.** The first caller after deploy becomes admin. The deployer must call `initialize_config` immediately after `solana program deploy` to avoid front-running. Verify `Config.admin` matches the expected pubkey before treating the program as operational.
- **Reputation schema is minimal.** Only completion-side counters are wired. Disputes-lost, validations-performed, and pool-removal counters are deferred.
