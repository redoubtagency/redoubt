use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{Bounty, BountyEscrow, BountyStatus};

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

    pub caller: Signer<'info>,
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

    bounty.status = BountyStatus::Approved;

    Ok(())
}
