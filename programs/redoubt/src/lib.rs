use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
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
    ) -> Result<()> {
        instructions::create_bounty::handler(
            ctx,
            bounty_id,
            metadata_uri,
            namespace,
            reward_amount,
            deadline,
            approved_claimer,
        )
    }

    pub fn create_bounty_spl(
        ctx: Context<CreateBountySpl>,
        bounty_id: u64,
        metadata_uri: String,
        namespace: String,
        reward_amount: u64,
        deadline: i64,
        approved_claimer: Pubkey,
    ) -> Result<()> {
        instructions::create_bounty_spl::handler(
            ctx,
            bounty_id,
            metadata_uri,
            namespace,
            reward_amount,
            deadline,
            approved_claimer,
        )
    }

    pub fn claim_bounty(ctx: Context<ClaimBounty>) -> Result<()> {
        instructions::claim_bounty::handler(ctx)
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

    pub fn approve_bounty_spl(ctx: Context<ApproveBountySpl>) -> Result<()> {
        instructions::approve_bounty_spl::handler(ctx)
    }

    pub fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
        instructions::cancel_bounty::handler(ctx)
    }

    pub fn cancel_bounty_spl(ctx: Context<CancelBountySpl>) -> Result<()> {
        instructions::cancel_bounty_spl::handler(ctx)
    }

    pub fn expire_bounty(ctx: Context<ExpireBounty>) -> Result<()> {
        instructions::expire_bounty::handler(ctx)
    }

    pub fn expire_bounty_spl(ctx: Context<ExpireBountySpl>) -> Result<()> {
        instructions::expire_bounty_spl::handler(ctx)
    }

    pub fn expire_submitted(ctx: Context<ExpireSubmitted>) -> Result<()> {
        instructions::expire_submitted::handler(ctx)
    }

    pub fn expire_submitted_spl(ctx: Context<ExpireSubmittedSpl>) -> Result<()> {
        instructions::expire_submitted_spl::handler(ctx)
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        decision: ResolveDecision,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, decision)
    }

    pub fn resolve_dispute_spl(
        ctx: Context<ResolveDisputeSpl>,
        decision: ResolveDecision,
    ) -> Result<()> {
        instructions::resolve_dispute_spl::handler(ctx, decision)
    }

    pub fn initialize_config(ctx: Context<InitializeConfig>, guardian: Pubkey) -> Result<()> {
        instructions::initialize_config::handler(ctx, guardian)
    }

    pub fn whitelist_token(ctx: Context<WhitelistToken>) -> Result<()> {
        instructions::whitelist_token::handler(ctx)
    }

    pub fn unwhitelist_token(ctx: Context<UnwhitelistToken>) -> Result<()> {
        instructions::unwhitelist_token::handler(ctx)
    }

    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::handler(ctx)
    }

    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::handler(ctx)
    }
}
