use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetTokenConfig<'info> {
    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ RedoubtError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<SetTokenConfig>, mint: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.redoubt_mint = mint;
    Ok(())
}
