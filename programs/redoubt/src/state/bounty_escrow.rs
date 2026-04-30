use anchor_lang::prelude::*;

#[account]
pub struct BountyEscrow {
    pub bounty: Pubkey,
    pub bump: u8,
}

impl BountyEscrow {
    pub const SEED: &'static [u8] = b"escrow";
    pub const SPACE: usize = 8 + 32 + 1;
}
