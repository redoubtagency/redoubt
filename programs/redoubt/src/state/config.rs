use anchor_lang::prelude::*;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub guardian: Pubkey,
    pub paused: bool,
    pub redoubt_mint: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const SEED: &'static [u8] = b"config";

    pub const SPACE: usize = 8
        + 32  // admin
        + 32  // guardian
        + 1   // paused
        + 32  // redoubt_mint
        + 1;  // bump
}
