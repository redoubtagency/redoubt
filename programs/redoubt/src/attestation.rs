use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program::ID as ED25519_PROGRAM_ID;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};

use crate::errors::RedoubtError;

pub const ATTESTATION_DOMAIN: &[u8] = b"redoubt-attest-v1";
pub const ATTESTATION_MESSAGE_LEN: usize = 17 + 32 + 32 + 32 + 8;

pub fn build_attestation_message(
    wallet: &Pubkey,
    position: &Pubkey,
    telecoin_id: &[u8; 32],
    expiry: i64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(ATTESTATION_MESSAGE_LEN);
    msg.extend_from_slice(ATTESTATION_DOMAIN);
    msg.extend_from_slice(wallet.as_ref());
    msg.extend_from_slice(position.as_ref());
    msg.extend_from_slice(telecoin_id);
    msg.extend_from_slice(&expiry.to_le_bytes());
    msg
}

// Confirms the instruction immediately preceding the current one is an Ed25519 verify
// instruction over (expected_signer, expected_message). The native Ed25519 program does
// the cryptographic check; this function only binds its declared inputs to ours.
pub fn verify_indexer_attestation(
    ix_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    require_keys_eq!(
        *ix_sysvar.key,
        INSTRUCTIONS_ID,
        RedoubtError::InvalidInstructionsSysvar
    );

    let current = load_current_index_checked(ix_sysvar)?;
    require!(current >= 1, RedoubtError::MissingEd25519Verify);

    let ed25519_ix = load_instruction_at_checked((current - 1) as usize, ix_sysvar)?;
    require_keys_eq!(
        ed25519_ix.program_id,
        ED25519_PROGRAM_ID,
        RedoubtError::MissingEd25519Verify
    );

    let data = ed25519_ix.data;
    require!(data.len() >= 16, RedoubtError::InvalidEd25519Verify);
    require!(data[0] == 1, RedoubtError::InvalidEd25519Verify);
    require!(data[1] == 0, RedoubtError::InvalidEd25519Verify);

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;

    require!(
        pubkey_offset + 32 <= data.len(),
        RedoubtError::InvalidEd25519Verify
    );
    require!(
        msg_offset + msg_size <= data.len(),
        RedoubtError::InvalidEd25519Verify
    );
    require!(
        sig_offset + 64 <= data.len(),
        RedoubtError::InvalidEd25519Verify
    );

    let signed_pubkey_bytes: [u8; 32] = data[pubkey_offset..pubkey_offset + 32]
        .try_into()
        .map_err(|_| error!(RedoubtError::InvalidEd25519Verify))?;
    let signed_pubkey = Pubkey::new_from_array(signed_pubkey_bytes);
    let signed_message = &data[msg_offset..msg_offset + msg_size];

    require_keys_eq!(
        signed_pubkey,
        *expected_signer,
        RedoubtError::WrongIndexerSigner
    );
    require!(
        signed_message == expected_message,
        RedoubtError::AttestationMismatch
    );

    Ok(())
}
