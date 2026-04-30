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
        constraint = token_whitelist.mint == mint.key() @ RedoubtError::InvalidEscrowMint,
    )]
    pub token_whitelist: Account<'info, TokenWhitelist>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

pub fn handler(_ctx: Context<UnwhitelistToken>) -> Result<()> {
    // Anchor handles closing via `close = admin` on the account constraint.
    Ok(())
}
