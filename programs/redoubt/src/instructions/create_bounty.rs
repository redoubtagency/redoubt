use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::RedoubtError;
use crate::state::{Agent, Bounty, BountyEscrow, BountyStatus};

#[derive(Accounts)]
#[instruction(bounty_id: u64)]
pub struct CreateBounty<'info> {
    #[account(
        init,
        payer = creator,
        space = Bounty::SPACE,
        seeds = [Bounty::SEED, creator.key().as_ref(), &bounty_id.to_le_bytes()],
        bump,
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        init,
        payer = creator,
        space = BountyEscrow::SPACE,
        seeds = [BountyEscrow::SEED, bounty.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, BountyEscrow>,

    #[account(
        seeds = [Agent::SEED, creator.key().as_ref()],
        bump = creator_agent.bump,
        constraint = creator_agent.is_active @ RedoubtError::AgentNotActive,
    )]
    pub creator_agent: Account<'info, Agent>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateBounty>,
    bounty_id: u64,
    metadata_uri: String,
    namespace: String,
    reward_amount: u64,
    deadline: i64,
    approved_claimer: Pubkey,
    min_tier_required: u8,
) -> Result<()> {
    require!(reward_amount > 0, RedoubtError::InvalidRewardAmount);
    require!(
        metadata_uri.len() <= Bounty::MAX_METADATA_URI_LEN,
        RedoubtError::MetadataUriTooLong
    );
    require!(
        namespace.len() <= Bounty::MAX_NAMESPACE_LEN,
        RedoubtError::NamespaceTooLong
    );

    let now = Clock::get()?.unix_timestamp;
    require!(deadline > now, RedoubtError::InvalidDeadline);

    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.creator.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
        },
    );
    system_program::transfer(cpi_ctx, reward_amount)?;

    let bounty = &mut ctx.accounts.bounty;
    bounty.creator = ctx.accounts.creator.key();
    bounty.bounty_id = bounty_id;
    bounty.metadata_uri = metadata_uri;
    bounty.namespace = namespace;
    bounty.reward_amount = reward_amount;
    bounty.status = BountyStatus::Open;
    bounty.claimer = Pubkey::default();
    bounty.approved_claimer = approved_claimer;
    bounty.submission_uri = String::new();
    bounty.submission_hash = [0u8; 32];
    bounty.deadline = deadline;
    bounty.created_at = now;
    bounty.claimed_at = 0;
    bounty.submitted_at = 0;
    bounty.min_tier_required = min_tier_required;
    bounty.bump = ctx.bumps.bounty;

    let escrow = &mut ctx.accounts.escrow;
    escrow.bounty = bounty.key();
    escrow.bump = ctx.bumps.escrow;

    Ok(())
}
