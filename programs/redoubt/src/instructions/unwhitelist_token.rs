use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::RedoubtError;
use crate::state::{Config, TokenWhitelist};

#[derive(Accounts)]
pub struct UnwhitelistToken<'info> {
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ RedoubtError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        close = admin,
        seeds = [TokenWhitelist::SEED, mint.key().as_ref()],
        bump = token_whitelist.bump,
        constraint = token_whitelist.mint == mint.key() @ RedoubtError::TokenNotWhitelisted,
    )]
    pub token_whitelist: Account<'info, TokenWhitelist>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[event]
pub struct TokenUnwhitelistedEvent {
    pub mint: Pubkey,
    pub admin: Pubkey,
    pub timestamp: i64,
}

pub fn handler(ctx: Context<UnwhitelistToken>) -> Result<()> {
    emit!(TokenUnwhitelistedEvent {
        mint: ctx.accounts.mint.key(),
        admin: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    // Anchor handles closing via `close = admin` on the account constraint.
    Ok(())
}
