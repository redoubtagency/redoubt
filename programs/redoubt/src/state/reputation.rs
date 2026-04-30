use anchor_lang::prelude::*;

#[account]
pub struct AgentReputation {
    pub agent: Pubkey,
    pub bounties_created: u64,
    pub bounties_completed: u64,
    pub total_value_completed: u64,
    pub last_bounty_at: i64,
    pub bump: u8,
}

impl AgentReputation {
    pub const SEED: &'static [u8] = b"reputation";

    pub const SPACE: usize = 8 // discriminator
        + 32  // agent
        + 8   // bounties_created
        + 8   // bounties_completed
        + 8   // total_value_completed
        + 8   // last_bounty_at
        + 1;  // bump

    pub fn record_completion(&mut self, value: u64, now: i64) {
        self.bounties_completed = self.bounties_completed.saturating_add(1);
        self.total_value_completed = self.total_value_completed.saturating_add(value);
        self.last_bounty_at = now;
    }

    pub fn record_creation(&mut self, now: i64) {
        self.bounties_created = self.bounties_created.saturating_add(1);
        self.last_bounty_at = now;
    }
}
