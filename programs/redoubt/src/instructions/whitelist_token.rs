use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::RedoubtError;
use crate::state::{Config, TokenWhitelist};

#[derive(Accounts)]
pub struct WhitelistToken<'info> {
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ RedoubtError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = TokenWhitelist::SPACE,
        seeds = [TokenWhitelist::SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_whitelist: Account<'info, TokenWhitelist>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct TokenWhitelistedEvent {
    pub mint: Pubkey,
    pub admin: Pubkey,
    pub timestamp: i64,
}

pub fn handler(ctx: Context<WhitelistToken>) -> Result<()> {
    let entry = &mut ctx.accounts.token_whitelist;
    entry.mint = ctx.accounts.mint.key();
    entry.bump = ctx.bumps.token_whitelist;

    emit!(TokenWhitelistedEvent {
        mint: ctx.accounts.mint.key(),
        admin: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
