use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{Bounty, BountyEscrow, BountyStatus};

#[derive(Accounts)]
pub struct ExpireBounty<'info> {
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

    /// CHECK: receives escrow lamports via Anchor's `close = creator`; pubkey verified
    /// against bounty.creator by the `has_one = creator` constraint above.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<ExpireBounty>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    let now = Clock::get()?.unix_timestamp;

    require!(
        matches!(bounty.status, BountyStatus::Open | BountyStatus::Claimed),
        RedoubtError::BountyNotExpirable
    );
    require!(now >= bounty.deadline, RedoubtError::BountyNotYetExpired);

    bounty.status = BountyStatus::Expired;

    Ok(())
}
