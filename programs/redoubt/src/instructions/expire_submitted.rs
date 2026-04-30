use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{AgentReputation, Bounty, BountyEscrow, BountyStatus};

#[derive(Accounts)]
pub struct ExpireSubmitted<'info> {
    #[account(
        mut,
        seeds = [Bounty::SEED, bounty.creator.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump,
        has_one = creator @ RedoubtError::NotCreator,
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        mut,
        close = creator,
        seeds = [BountyEscrow::SEED, bounty.key().as_ref()],
        bump = escrow.bump,
        has_one = bounty,
    )]
    pub escrow: Account<'info, BountyEscrow>,

    /// CHECK: receives the rent-exempt remainder via Anchor's `close = creator`;
    /// pubkey verified against bounty.creator by `has_one`.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    /// CHECK: receives the bounty reward; verified against bounty.claimer in handler.
    #[account(
        mut,
        constraint = claimer.key() == bounty.claimer @ RedoubtError::NotClaimer,
    )]
    pub claimer: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = caller,
        space = AgentReputation::SPACE,
        seeds = [AgentReputation::SEED, bounty.creator.as_ref()],
        bump,
    )]
    pub creator_reputation: Account<'info, AgentReputation>,

    #[account(
        init_if_needed,
        payer = caller,
        space = AgentReputation::SPACE,
        seeds = [AgentReputation::SEED, bounty.claimer.as_ref()],
        bump,
    )]
    pub claimer_reputation: Account<'info, AgentReputation>,

    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExpireSubmitted>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    let now = Clock::get()?.unix_timestamp;

    require!(
        bounty.status == BountyStatus::Submitted,
        RedoubtError::BountyNotSubmitted
    );

    let release_at = bounty
        .deadline
        .checked_add(Bounty::SUBMISSION_GRACE_SECONDS)
        .ok_or(RedoubtError::SubmissionGraceNotElapsed)?;
    require!(now >= release_at, RedoubtError::SubmissionGraceNotElapsed);

    let escrow_info = ctx.accounts.escrow.to_account_info();
    let claimer_info = ctx.accounts.claimer.to_account_info();
    let reward = bounty.reward_amount;

    let escrow_lamports = escrow_info.lamports();
    require!(escrow_lamports >= reward, RedoubtError::EscrowUnderfunded);

    // Reward routes to claimer; rent-exempt remainder returns to creator via `close`.
    **escrow_info.try_borrow_mut_lamports()? = escrow_lamports
        .checked_sub(reward)
        .ok_or(RedoubtError::EscrowUnderfunded)?;
    **claimer_info.try_borrow_mut_lamports()? = claimer_info
        .lamports()
        .checked_add(reward)
        .ok_or(RedoubtError::EscrowUnderfunded)?;

    let creator_rep = &mut ctx.accounts.creator_reputation;
    creator_rep.agent = bounty.creator;
    creator_rep.bump = ctx.bumps.creator_reputation;
    creator_rep.record_creation(now);

    let claimer_rep = &mut ctx.accounts.claimer_reputation;
    claimer_rep.agent = bounty.claimer;
    claimer_rep.bump = ctx.bumps.claimer_reputation;
    claimer_rep.record_completion(reward, now);

    bounty.status = BountyStatus::Approved;

    Ok(())
}
