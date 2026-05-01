use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{AgentReputation, Bounty, BountyEscrow, BountyStatus, Config, EscrowType};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResolveDecision {
    AwardClaimer,
    RefundCreator,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
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

    /// CHECK: receives lamports via Anchor's `close = creator`; pubkey verified by has_one.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    /// CHECK: For AwardClaimer, address is verified against bounty.claimer in handler.
    /// For RefundCreator, this account is unused but still passed to keep the account
    /// layout uniform across both decisions.
    #[account(mut)]
    pub claimer: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = admin,
        space = AgentReputation::SPACE,
        seeds = [AgentReputation::SEED, bounty.creator.as_ref()],
        bump,
    )]
    pub creator_reputation: Account<'info, AgentReputation>,

    #[account(
        init_if_needed,
        payer = admin,
        space = AgentReputation::SPACE,
        seeds = [AgentReputation::SEED, bounty.claimer.as_ref()],
        bump,
    )]
    pub claimer_reputation: Account<'info, AgentReputation>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ RedoubtError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResolveDispute>, decision: ResolveDecision) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;

    // Both decisions require the bounty to have a claimer: AwardClaimer needs a
    // payee, and RefundCreator without an active claim is just a creator-cancel
    // path that already exists as cancel_bounty. Restricting here keeps SOL and
    // SPL admin-override semantics symmetric.
    require!(
        matches!(
            bounty.status,
            BountyStatus::Claimed | BountyStatus::Submitted | BountyStatus::Disputed
        ),
        RedoubtError::BountyAlreadyResolved
    );
    require!(
        bounty.escrow_type == EscrowType::Sol,
        RedoubtError::WrongEscrowType
    );

    match decision {
        ResolveDecision::AwardClaimer => {
            require_keys_eq!(
                ctx.accounts.claimer.key(),
                bounty.claimer,
                RedoubtError::NotClaimer
            );

            let escrow_info = ctx.accounts.escrow.to_account_info();
            let claimer_info = ctx.accounts.claimer.to_account_info();
            let reward = bounty.reward_amount;

            let escrow_lamports = escrow_info.lamports();
            require!(escrow_lamports >= reward, RedoubtError::EscrowUnderfunded);

            // Reward to claimer; rent-exempt remainder routes to creator via close.
            **escrow_info.try_borrow_mut_lamports()? = escrow_lamports
                .checked_sub(reward)
                .ok_or(RedoubtError::EscrowUnderfunded)?;
            **claimer_info.try_borrow_mut_lamports()? = claimer_info
                .lamports()
                .checked_add(reward)
                .ok_or(RedoubtError::EscrowUnderfunded)?;

            let now = Clock::get()?.unix_timestamp;

            let creator_rep = &mut ctx.accounts.creator_reputation;
            creator_rep.agent = bounty.creator;
            creator_rep.bump = ctx.bumps.creator_reputation;
            creator_rep.record_creation(now);

            let claimer_rep = &mut ctx.accounts.claimer_reputation;
            claimer_rep.agent = bounty.claimer;
            claimer_rep.bump = ctx.bumps.claimer_reputation;
            claimer_rep.record_completion(reward, now);

            bounty.status = BountyStatus::Approved;
        }
        ResolveDecision::RefundCreator => {
            // close = creator routes everything (reward + rent) to creator.
            // Reputation accounts are still allocated (cost of admin call) but not mutated:
            // a refund is not a positive reputation event for either party.
            let now = Clock::get()?.unix_timestamp;
            let creator_rep = &mut ctx.accounts.creator_reputation;
            if creator_rep.agent == Pubkey::default() {
                creator_rep.agent = bounty.creator;
                creator_rep.bump = ctx.bumps.creator_reputation;
                creator_rep.last_bounty_at = now;
            }
            // bounty.claimer is guaranteed non-default since the outer status
            // check restricts to Claimed | Submitted | Disputed (all set claimer).
            let claimer_rep = &mut ctx.accounts.claimer_reputation;
            if claimer_rep.agent == Pubkey::default() {
                claimer_rep.agent = bounty.claimer;
                claimer_rep.bump = ctx.bumps.claimer_reputation;
                claimer_rep.last_bounty_at = now;
            }

            bounty.status = BountyStatus::Cancelled;
        }
    }

    Ok(())
}
