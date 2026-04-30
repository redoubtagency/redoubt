use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{Agent, Bounty, BountyStatus};

#[derive(Accounts)]
pub struct ClaimBounty<'info> {
    #[account(
        mut,
        seeds = [Bounty::SEED, bounty.creator.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump,
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        seeds = [Agent::SEED, claimer.key().as_ref()],
        bump = claimer_agent.bump,
        constraint = claimer_agent.is_active @ RedoubtError::AgentNotActive,
    )]
    pub claimer_agent: Account<'info, Agent>,

    pub claimer: Signer<'info>,
}

pub fn handler(ctx: Context<ClaimBounty>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;

    require!(bounty.status == BountyStatus::Open, RedoubtError::BountyNotOpen);

    if bounty.approved_claimer != Pubkey::default() {
        require_keys_eq!(
            ctx.accounts.claimer.key(),
            bounty.approved_claimer,
            RedoubtError::NotApprovedClaimer
        );
    }

    let now = Clock::get()?.unix_timestamp;
    bounty.status = BountyStatus::Claimed;
    bounty.claimer = ctx.accounts.claimer.key();
    bounty.claimed_at = now;

    Ok(())
}
