use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

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
}
