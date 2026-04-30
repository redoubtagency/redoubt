use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::Config;

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = admin @ RedoubtError::NotAdmin,
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<Unpause>) -> Result<()> {
    ctx.accounts.config.paused = false;
    Ok(())
}
