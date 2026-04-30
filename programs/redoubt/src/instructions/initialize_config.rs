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

pub fn handler(ctx: Context<InitializeConfig>, guardian: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.guardian = guardian;
    config.paused = false;
    config.redoubt_mint = Pubkey::default();
    config.redoubt_telecoin_id = [0u8; 32];
    config.indexer_pubkey = Pubkey::default();
    config.bump = ctx.bumps.config;
    Ok(())
}
