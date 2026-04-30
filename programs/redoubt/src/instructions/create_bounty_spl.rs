use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::RedoubtError;
use crate::state::{Agent, Bounty, BountyEscrow, BountyStatus, Config, EscrowType, TokenWhitelist};

#[derive(Accounts)]
#[instruction(bounty_id: u64)]
pub struct CreateBountySpl<'info> {
    #[account(
        init,
        payer = creator,
        space = Bounty::SPACE,
        seeds = [Bounty::SEED, creator.key().as_ref(), &bounty_id.to_le_bytes()],
        bump,
    )]
    pub bounty: Box<Account<'info, Bounty>>,

    #[account(
        init,
        payer = creator,
        space = BountyEscrow::SPACE,
        seeds = [BountyEscrow::SEED, bounty.key().as_ref()],
        bump,
    )]
    pub escrow: Box<Account<'info, BountyEscrow>>,

    #[account(
        seeds = [Agent::SEED, creator.key().as_ref()],
        bump = creator_agent.bump,
        constraint = creator_agent.is_active @ RedoubtError::AgentNotActive,
    )]
    pub creator_agent: Box<Account<'info, Agent>>,

    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [TokenWhitelist::SEED, mint.key().as_ref()],
        bump = token_whitelist.bump,
        constraint = token_whitelist.mint == mint.key() @ RedoubtError::TokenNotWhitelisted,
    )]
    pub token_whitelist: Box<Account<'info, TokenWhitelist>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handler(
    ctx: Context<CreateBountySpl>,
    bounty_id: u64,
    metadata_uri: String,
    namespace: String,
    reward_amount: u64,
    deadline: i64,
    approved_claimer: Pubkey,
    min_tier_required: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, RedoubtError::ProgramPaused);
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

    // Transfer tokens from creator's ATA to the escrow ATA owned by the BountyEscrow PDA.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, reward_amount)?;

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
    bounty.escrow_type = EscrowType::SplToken;
    bounty.escrow_mint = ctx.accounts.mint.key();

    let escrow = &mut ctx.accounts.escrow;
    escrow.bounty = bounty.key();
    escrow.bump = ctx.bumps.escrow;

    Ok(())
}
