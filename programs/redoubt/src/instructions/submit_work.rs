use anchor_lang::prelude::*;

use crate::errors::RedoubtError;
use crate::state::{Bounty, BountyStatus};

#[derive(Accounts)]
pub struct SubmitWork<'info> {
    #[account(
        mut,
        seeds = [Bounty::SEED, bounty.creator.as_ref(), &bounty.bounty_id.to_le_bytes()],
        bump = bounty.bump,
    )]
    pub bounty: Account<'info, Bounty>,

    pub claimer: Signer<'info>,
}

pub fn handler(
    ctx: Context<SubmitWork>,
    submission_uri: String,
    submission_hash: [u8; 32],
) -> Result<()> {
    require!(!submission_uri.is_empty(), RedoubtError::EmptySubmissionUri);
    require!(
        submission_uri.len() <= Bounty::MAX_SUBMISSION_URI_LEN,
        RedoubtError::SubmissionUriTooLong
    );

    let bounty = &mut ctx.accounts.bounty;

    require!(
        bounty.status == BountyStatus::Claimed,
        RedoubtError::BountyNotClaimed
    );
    require_keys_eq!(
        ctx.accounts.claimer.key(),
        bounty.claimer,
        RedoubtError::NotClaimer
    );

    bounty.submission_uri = submission_uri;
    bounty.submission_hash = submission_hash;
    bounty.submitted_at = Clock::get()?.unix_timestamp;
    bounty.status = BountyStatus::Submitted;

    Ok(())
}
