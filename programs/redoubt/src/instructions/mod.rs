// Glob re-exports are required by the Anchor #[program] macro, which expects
// each instruction module's auto-generated client_accounts_* helpers to be
// reachable via `crate::instructions::*`. The per-module `handler` function
// names collide under the glob; the lint is benign because lib.rs always
// calls handlers via the fully-qualified path (instructions::<name>::handler).
#![allow(ambiguous_glob_reexports)]

pub mod register_agent;
pub mod create_bounty;
pub mod create_bounty_spl;
pub mod claim_bounty;
pub mod submit_work;
pub mod approve_bounty;
pub mod approve_bounty_spl;
pub mod cancel_bounty;
pub mod cancel_bounty_spl;
pub mod expire_bounty;
pub mod expire_bounty_spl;
pub mod expire_submitted;
pub mod expire_submitted_spl;
pub mod resolve_dispute;
pub mod resolve_dispute_spl;
pub mod initialize_config;
pub mod whitelist_token;
pub mod unwhitelist_token;
pub mod pause;
pub mod unpause;

pub use register_agent::*;
pub use create_bounty::*;
pub use create_bounty_spl::*;
pub use claim_bounty::*;
pub use submit_work::*;
pub use approve_bounty::*;
pub use approve_bounty_spl::*;
pub use cancel_bounty::*;
pub use cancel_bounty_spl::*;
pub use expire_bounty::*;
pub use expire_bounty_spl::*;
pub use expire_submitted::*;
pub use expire_submitted_spl::*;
pub use resolve_dispute::*;
pub use resolve_dispute_spl::*;
pub use initialize_config::*;
pub use whitelist_token::*;
pub use unwhitelist_token::*;
pub use pause::*;
pub use unpause::*;
