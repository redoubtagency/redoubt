use anchor_lang::prelude::*;

#[account]
pub struct Agent {
    pub wallet: Pubkey,
    pub did_uri: String,
    pub registered_at: i64,
    pub updated_at: i64,
    pub is_verified: bool,
    pub is_active: bool,
    pub agent_type: u8,
    pub bump: u8,
}

impl Agent {
    pub const SEED: &'static [u8] = b"agent";
    pub const MAX_DID_URI_LEN: usize = 200;

    pub const SPACE: usize = 8
        + 32
        + (4 + Self::MAX_DID_URI_LEN)
        + 8
        + 8
        + 1
        + 1
        + 1
        + 1;
}
