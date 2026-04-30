use anchor_lang::prelude::*;

pub mod attestation;
pub mod errors;
pub mod instructions;
pub mod printr;
pub mod state;

use instructions::*;

declare_id!("AV7aXKi6SNDG8TinRotfUrTj87d1ydHzc7RwxGhTeYt2");

#[program]
pub mod redoubt {
    use super::*;

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        did_uri: String,
        agent_type: u8,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, did_uri, agent_type)
    }

    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        bounty_id: u64,
        metadata_uri: String,
        namespace: String,
        reward_amount: u64,
        deadline: i64,
        approved_claimer: Pubkey,
        min_tier_required: u8,
    ) -> Result<()> {
        instructions::create_bounty::handler(
            ctx,
            bounty_id,
            metadata_uri,
            namespace,
            reward_amount,
            deadline,
            approved_claimer,
            min_tier_required,
        )
    }

    pub fn claim_bounty(ctx: Context<ClaimBounty>, expiry: i64) -> Result<()> {
        instructions::claim_bounty::handler(ctx, expiry)
    }

    pub fn submit_work(
        ctx: Context<SubmitWork>,
        submission_uri: String,
        submission_hash: [u8; 32],
    ) -> Result<()> {
        instructions::submit_work::handler(ctx, submission_uri, submission_hash)
    }

    pub fn approve_bounty(ctx: Context<ApproveBounty>) -> Result<()> {
        instructions::approve_bounty::handler(ctx)
    }

    pub fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
        instructions::cancel_bounty::handler(ctx)
    }

    pub fn expire_bounty(ctx: Context<ExpireBounty>) -> Result<()> {
        instructions::expire_bounty::handler(ctx)
    }

    pub fn expire_submitted(ctx: Context<ExpireSubmitted>) -> Result<()> {
        instructions::expire_submitted::handler(ctx)
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        decision: ResolveDecision,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, decision)
    }

    pub fn initialize_config(ctx: Context<InitializeConfig>, guardian: Pubkey) -> Result<()> {
        instructions::initialize_config::handler(ctx, guardian)
    }

    pub fn set_token_config(
        ctx: Context<SetTokenConfig>,
        mint: Pubkey,
        telecoin_id: [u8; 32],
        indexer_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::set_token_config::handler(ctx, mint, telecoin_id, indexer_pubkey)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handler(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handler(ctx)
    }
}
