use anchor_lang::prelude::*;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub guardian: Pubkey,
    pub paused: bool,
    pub redoubt_mint: Pubkey,
    pub redoubt_telecoin_id: [u8; 32],
    pub indexer_pubkey: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const SEED: &'static [u8] = b"config";

    pub const SPACE: usize = 8
        + 32
        + 32
        + 1
        + 32
        + 32
        + 32
        + 1;
}
