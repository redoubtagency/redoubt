use anchor_lang::prelude::*;

use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [Config::SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[event]
pub struct ConfigInitializedEvent {
    pub admin: Pubkey,
    pub guardian: Pubkey,
    pub timestamp: i64,
}

pub fn handler(ctx: Context<InitializeConfig>, guardian: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.guardian = guardian;
    config.paused = false;
    config.bump = ctx.bumps.config;

    emit!(ConfigInitializedEvent {
        admin: config.admin,
        guardian,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
