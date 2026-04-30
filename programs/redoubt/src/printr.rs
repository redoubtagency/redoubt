use anchor_lang::prelude::*;
use anchor_lang::pubkey;

use crate::errors::RedoubtError;

pub const PRINTR_STAKING_PROGRAM_ID: Pubkey =
    pubkey!("T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint");

// First 8 bytes of every Printr POB position account, in on-wire order.
pub const POSITION_DISCRIMINATOR: [u8; 8] =
    [0x4e, 0xa5, 0x1e, 0x6f, 0xab, 0x7d, 0x0b, 0xdc];

pub const POSITION_ACCOUNT_LEN: usize = 62;
pub const STAKED_AMOUNT_OFFSET: usize = 13;
pub const LOCK_PERIOD_OFFSET: usize = 21;
pub const CREATED_AT_OFFSET: usize = 22;

pub struct PositionView {
    pub staked_amount: u64,
    pub lock_period_index: u8,
    pub created_at: i64,
}

pub fn parse_position(data: &[u8]) -> Result<PositionView> {
    require!(
        data.len() >= POSITION_ACCOUNT_LEN,
        RedoubtError::InvalidPositionAccount
    );
    require!(
        data[0..8] == POSITION_DISCRIMINATOR,
        RedoubtError::InvalidPositionAccount
    );

    let staked_amount = u64::from_le_bytes(
        data[STAKED_AMOUNT_OFFSET..STAKED_AMOUNT_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(RedoubtError::InvalidPositionAccount))?,
    );
    let lock_period_index = data[LOCK_PERIOD_OFFSET];
    let created_at = i64::from_le_bytes(
        data[CREATED_AT_OFFSET..CREATED_AT_OFFSET + 8]
            .try_into()
            .map_err(|_| error!(RedoubtError::InvalidPositionAccount))?,
    );

    Ok(PositionView {
        staked_amount,
        lock_period_index,
        created_at,
    })
}

pub fn verify_position_account(account: &AccountInfo) -> Result<PositionView> {
    require_keys_eq!(
        *account.owner,
        PRINTR_STAKING_PROGRAM_ID,
        RedoubtError::PositionWrongOwner
    );
    let data = account.try_borrow_data()?;
    parse_position(&data)
}
