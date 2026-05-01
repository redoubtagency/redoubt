use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::RedoubtError;
use crate::instructions::resolve_dispute::ResolveDecision;
use crate::state::{AgentReputation, Bounty, BountyEscrow, BountyStatus, Config, EscrowType};

// SPL admin force-resolve. Asymmetric with the SOL variant: requires the bounty
// to have a claimer (status in Claimed | Submitted | Disputed), because both
// destination ATAs (creator + claimer) must exist as Anchor accounts. Open SPL
// bounties have claimer = Pubkey::default(), which has no canonical ATA — use
// cancel_bounty_spl (creator) or expire_bounty_spl (after deadline) instead.
#[derive(Accounts)]
pub struct ResolveDisputeSpl<'info> {
    #[account(
        mut,
        seeds = [Bounty::SEED, bounty.creator.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump,
        has_one = creator @ RedoubtError::NotCreator,
        constraint = bounty.escrow_mint == mint.key() @ RedoubtError::InvalidEscrowMint,
    )]
    pub bounty: Box<Account<'info, Bounty>>,

    #[account(
        mut,
        close = creator,
        seeds = [BountyEscrow::SEED, bounty.key().as_ref()],
        bump = escrow.bump,
        has_one = bounty,
    )]
    pub escrow: Box<Account<'info, BountyEscrow>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: receives BountyEscrow PDA rent via Anchor's `close = creator`; pubkey
    /// verified against bounty.creator by `has_one` above.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: pubkey verified against bounty.claimer by the constraint below.
    #[account(
        mut,
        constraint = claimer.key() == bounty.claimer @ RedoubtError::NotClaimer,
    )]
    pub claimer: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = claimer,
    )]
    pub claimer_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = admin,
        space = AgentReputation::SPACE,
        seeds = [AgentReputation::SEED, bounty.creator.as_ref()],
        bump,
    )]
    pub creator_reputation: Box<Account<'info, AgentReputation>>,

    #[account(
        init_if_needed,
        payer = admin,
        space = AgentReputation::SPACE,
        seeds = [AgentReputation::SEED, bounty.claimer.as_ref()],
        bump,
    )]
    pub claimer_reputation: Box<Account<'info, AgentReputation>>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ RedoubtError::NotAdmin,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(ctx: Context<ResolveDisputeSpl>, decision: ResolveDecision) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;

    require!(
        matches!(
            bounty.status,
            BountyStatus::Claimed | BountyStatus::Submitted | BountyStatus::Disputed
        ),
        RedoubtError::BountyAlreadyResolved
    );
    require!(
        bounty.escrow_type == EscrowType::SplToken,
        RedoubtError::WrongEscrowType
    );

    let reward = bounty.reward_amount;
    let bounty_key = bounty.key();
    let escrow_bump = ctx.accounts.escrow.bump;
    let escrow_seeds: &[&[u8]] = &[BountyEscrow::SEED, bounty_key.as_ref(), &[escrow_bump]];
    let signer_seeds: &[&[&[u8]]] = &[escrow_seeds];

    let now = Clock::get()?.unix_timestamp;

    match decision {
        ResolveDecision::AwardClaimer => {
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.claimer_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, reward)?;

            let close_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_token_account.to_account_info(),
                    destination: ctx.accounts.creator.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            );
            token::close_account(close_ctx)?;

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
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, reward)?;

            let close_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_token_account.to_account_info(),
                    destination: ctx.accounts.creator.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            );
            token::close_account(close_ctx)?;

            // Mark reputation PDAs as touched (admin paid for the init), but a
            // refund is not a positive reputation event for either party.
            let creator_rep = &mut ctx.accounts.creator_reputation;
            if creator_rep.agent == Pubkey::default() {
                creator_rep.agent = bounty.creator;
                creator_rep.bump = ctx.bumps.creator_reputation;
                creator_rep.last_bounty_at = now;
            }
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
