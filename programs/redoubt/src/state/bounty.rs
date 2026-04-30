use anchor_lang::prelude::*;

#[account]
pub struct Bounty {
    pub creator: Pubkey,
    pub bounty_id: u64,
    pub metadata_uri: String,
    pub namespace: String,
    pub reward_amount: u64,
    pub status: BountyStatus,
    pub claimer: Pubkey,
    pub approved_claimer: Pubkey,
    pub submission_uri: String,
    pub submission_hash: [u8; 32],
    pub deadline: i64,
    pub created_at: i64,
    pub claimed_at: i64,
    pub submitted_at: i64,
    pub min_tier_required: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BountyStatus {
    Open,
    Claimed,
    Submitted,
    Approved,
    Disputed,
    Cancelled,
    Expired,
}

impl Bounty {
    pub const SEED: &'static [u8] = b"bounty";
    pub const MAX_METADATA_URI_LEN: usize = 200;
    pub const MAX_NAMESPACE_LEN: usize = 64;
    pub const MAX_SUBMISSION_URI_LEN: usize = 200;

    pub const SPACE: usize = 8
        + 32
        + 8
        + (4 + Self::MAX_METADATA_URI_LEN)
        + (4 + Self::MAX_NAMESPACE_LEN)
        + 8
        + 1
        + 32
        + 32
        + (4 + Self::MAX_SUBMISSION_URI_LEN)
        + 32
        + 8
        + 8
        + 8
        + 8
        + 1
        + 1;
}
