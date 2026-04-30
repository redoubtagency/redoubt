use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{Bounty, BountyEscrow, BountyStatus, EscrowType};

#[derive(Accounts)]
pub struct CancelBounty<'info> {
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

    #[account(mut)]
    pub creator: Signer<'info>,
}

pub fn handler(ctx: Context<CancelBounty>) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;

    require!(
        bounty.status == BountyStatus::Open,
        RedoubtError::BountyNotOpen
    );
    require!(
        bounty.escrow_type == EscrowType::Sol,
        RedoubtError::WrongEscrowType
    );

    bounty.status = BountyStatus::Cancelled;

    Ok(())
}
