use anchor_lang::prelude::*;

#[account]
pub struct TokenWhitelist {
    pub mint: Pubkey,
    pub bump: u8,
}

impl TokenWhitelist {
    pub const SEED: &'static [u8] = b"token_whitelist";

    pub const SPACE: usize = 8 // discriminator
        + 32  // mint
        + 1;  // bump
}
