use anchor_lang::prelude::*;

#[error_code]
pub enum RedoubtError {
    #[msg("DID URI must not be empty")]
    EmptyDidUri,
    #[msg("DID URI exceeds maximum length")]
    DidUriTooLong,

    #[msg("Metadata URI exceeds maximum length")]
    MetadataUriTooLong,
    #[msg("Namespace exceeds maximum length")]
    NamespaceTooLong,
    #[msg("Submission URI must not be empty")]
    EmptySubmissionUri,
    #[msg("Submission URI exceeds maximum length")]
    SubmissionUriTooLong,

    #[msg("Reward amount must be greater than zero")]
    InvalidRewardAmount,
    #[msg("Deadline must be in the future")]
    InvalidDeadline,

    #[msg("Bounty is not in Open state")]
    BountyNotOpen,
    #[msg("Bounty is not in Claimed state")]
    BountyNotClaimed,
    #[msg("Bounty is not in Submitted state")]
    BountyNotSubmitted,
    #[msg("Bounty status does not allow this expiry path")]
    BountyNotExpirable,
    #[msg("Bounty deadline has not been reached yet")]
    BountyNotYetExpired,
    #[msg("Submission grace period has not elapsed")]
    SubmissionGraceNotElapsed,
    #[msg("Bounty is already in a terminal status")]
    BountyAlreadyResolved,

    #[msg("Token mint is not whitelisted for SPL escrow")]
    TokenNotWhitelisted,
    #[msg("Bounty escrow type does not match the instruction")]
    WrongEscrowType,
    #[msg("Mint account does not match the bounty's escrow mint")]
    InvalidEscrowMint,

    #[msg("Program is paused")]
    ProgramPaused,

    #[msg("Caller is not the bounty creator")]
    NotCreator,
    #[msg("Caller is not the bounty claimer")]
    NotClaimer,
    #[msg("Caller is not the approved claimer for this bounty")]
    NotApprovedClaimer,

    #[msg("Agent is not active")]
    AgentNotActive,

    #[msg("Escrow balance is insufficient to release reward")]
    EscrowUnderfunded,

    #[msg("Caller is not the configured admin")]
    NotAdmin,
    #[msg("Caller is not the admin or guardian")]
    NotAdminOrGuardian,

    #[msg("Config PDA address does not match the canonical derivation")]
    InvalidConfigPda,
}
