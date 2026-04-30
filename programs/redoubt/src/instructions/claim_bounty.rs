use anchor_lang::prelude::*;

use crate::attestation::{build_attestation_message, verify_indexer_attestation};
use crate::errors::RedoubtError;
use crate::printr::verify_position_account;
use crate::state::{Agent, Bounty, BountyStatus, Config};

#[derive(Accounts)]
pub struct ClaimBounty<'info> {
    #[account(
        mut,
        seeds = [Bounty::SEED, bounty.creator.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump,
    )]
    pub bounty: Account<'info, Bounty>,

    #[account(
        seeds = [Agent::SEED, claimer.key().as_ref()],
        bump = claimer_agent.bump,
        constraint = claimer_agent.is_active @ RedoubtError::AgentNotActive,
    )]
    pub claimer_agent: Account<'info, Agent>,

    pub claimer: Signer<'info>,

    pub config: Option<Account<'info, Config>>,

    /// CHECK: Owned by the Printr staking program; bytes parsed against a fixed schema.
    pub position: Option<UncheckedAccount<'info>>,

    /// CHECK: Address verified inline against the canonical instructions sysvar.
    pub instructions_sysvar: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<ClaimBounty>, expiry: i64) -> Result<()> {
    let bounty = &mut ctx.accounts.bounty;
    require!(bounty.status == BountyStatus::Open, RedoubtError::BountyNotOpen);

    if bounty.approved_claimer != Pubkey::default() {
        require_keys_eq!(
            ctx.accounts.claimer.key(),
            bounty.approved_claimer,
            RedoubtError::NotApprovedClaimer
        );
    }

    if bounty.min_tier_required > 0 {
        let config = ctx
            .accounts
            .config
            .as_ref()
            .ok_or(error!(RedoubtError::ConfigRequired))?;
        let position = ctx
            .accounts
            .position
            .as_ref()
            .ok_or(error!(RedoubtError::PositionRequired))?;
        let ix_sysvar = ctx
            .accounts
            .instructions_sysvar
            .as_ref()
            .ok_or(error!(RedoubtError::InstructionsSysvarRequired))?;

        let (expected_config, _) =
            Pubkey::find_program_address(&[Config::SEED], ctx.program_id);
        require_keys_eq!(
            config.key(),
            expected_config,
            RedoubtError::InvalidConfigPda
        );

        require!(
            config.indexer_pubkey != Pubkey::default(),
            RedoubtError::IndexerNotConfigured
        );
        require!(
            config.redoubt_telecoin_id != [0u8; 32],
            RedoubtError::TelecoinIdNotConfigured
        );

        let view = verify_position_account(&position.to_account_info())?;
        require!(
            view.lock_period_index >= bounty.min_tier_required - 1,
            RedoubtError::TierBelowMinimum
        );

        let now = Clock::get()?.unix_timestamp;
        require!(expiry > now, RedoubtError::AttestationExpired);

        let message = build_attestation_message(
            &ctx.accounts.claimer.key(),
            &position.key(),
            &config.redoubt_telecoin_id,
            expiry,
        );
        verify_indexer_attestation(
            &ix_sysvar.to_account_info(),
            &config.indexer_pubkey,
            &message,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    bounty.status = BountyStatus::Claimed;
    bounty.claimer = ctx.accounts.claimer.key();
    bounty.claimed_at = now;

    Ok(())
}
