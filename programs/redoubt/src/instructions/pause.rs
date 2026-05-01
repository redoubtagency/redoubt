use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::Config;

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    pub authority: Signer<'info>,
}

#[event]
pub struct ProgramPausedEvent {
    pub authority: Pubkey,
    pub timestamp: i64,
}

pub fn handler(ctx: Context<Pause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let caller = ctx.accounts.authority.key();
    require!(
        caller == config.admin || caller == config.guardian,
        RedoubtError::NotAdminOrGuardian
    );
    config.paused = true;

    emit!(ProgramPausedEvent {
        authority: caller,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
