use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::Agent;

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = wallet,
        space = Agent::SPACE,
        seeds = [Agent::SEED, wallet.key().as_ref()],
        bump,
    )]
    pub agent: Account<'info, Agent>,

    #[account(mut)]
    pub wallet: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterAgent>, did_uri: String, agent_type: u8) -> Result<()> {
    require!(!did_uri.is_empty(), RedoubtError::EmptyDidUri);
    require!(
        did_uri.len() <= Agent::MAX_DID_URI_LEN,
        RedoubtError::DidUriTooLong
    );

    let now = Clock::get()?.unix_timestamp;
    let agent = &mut ctx.accounts.agent;

    agent.wallet = ctx.accounts.wallet.key();
    agent.did_uri = did_uri;
    agent.registered_at = now;
    agent.updated_at = now;
    agent.is_verified = false;
    agent.is_active = true;
    agent.agent_type = agent_type;
    agent.bump = ctx.bumps.agent;

    Ok(())
}
