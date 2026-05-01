import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";

import { Redoubt } from "../target/types/redoubt";

// SPL escrow Phase 2: expire_bounty_spl, expire_submitted_spl, resolve_dispute_spl.
// Mirrors the Phase 1 patterns and adds the deadline-based + admin-override
// drain paths for SPL bounties.

describe("redoubt: spl phase 2", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const payer = (provider.wallet as anchor.Wallet).payer;
  const creator = Keypair.generate();
  const claimer = Keypair.generate();
  const stranger = Keypair.generate();

  let creatorAgentPda: PublicKey;
  let claimerAgentPda: PublicKey;
  let configPda: PublicKey;

  let mint: PublicKey;
  let creatorTokenAccount: PublicKey;

  const REWARD = 1_000_000n;
  const INITIAL_BALANCE = 100_000_000n;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const airdrop = async (pk: PublicKey, lamports: number) => {
    const sig = await connection.requestAirdrop(pk, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  };

  const reputationPda = (wallet: PublicKey) => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), wallet.toBuffer()],
      program.programId,
    );
    return pda;
  };

  const tokenWhitelistPda = (m: PublicKey) => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_whitelist"), m.toBuffer()],
      program.programId,
    );
    return pda;
  };

  const bountyPdas = (id: BN) => {
    const [bounty] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bounty"),
        creator.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), bounty.toBuffer()],
      program.programId,
    );
    return { bounty, escrow };
  };

  const createSplBounty = async (id: BN, deadlineSec: number) => {
    const { bounty, escrow } = bountyPdas(id);
    const escrowAta = getAssociatedTokenAddressSync(mint, escrow, true);

    await program.methods
      .createBountySpl(
        id,
        "https://example.com/bounty/p2",
        "test",
        new BN(REWARD.toString()),
        new BN(deadlineSec),
        PublicKey.default,
      )
      .accounts({
        bounty,
        escrow,
        creatorAgent: creatorAgentPda,
        config: configPda,
        mint,
        tokenWhitelist: tokenWhitelistPda(mint),
        creatorTokenAccount,
        escrowTokenAccount: escrowAta,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();
    return { bounty, escrow, escrowAta };
  };

  const driveToSubmitted = async (id: BN, deadlineSec: number) => {
    const { bounty, escrow, escrowAta } = await createSplBounty(id, deadlineSec);
    await program.methods
      .claimBounty()
      .accounts({
        bounty,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: configPda,
      })
      .signers([claimer])
      .rpc();
    const submissionHash = Array.from(
      crypto.createHash("sha256").update(`p2-${id.toString()}`).digest(),
    );
    await program.methods
      .submitWork("https://example.com/submission/p2", submissionHash)
      .accounts({
        bounty,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();
    return { bounty, escrow, escrowAta };
  };

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );
    [creatorAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), creator.publicKey.toBuffer()],
      program.programId,
    );
    [claimerAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), claimer.publicKey.toBuffer()],
      program.programId,
    );

    await airdrop(creator.publicKey, 5 * LAMPORTS_PER_SOL);
    await airdrop(claimer.publicKey, 1 * LAMPORTS_PER_SOL);
    await airdrop(stranger.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .registerAgent("did:redoubt:p2-creator", 1)
      .accounts({
        agent: creatorAgentPda,
        wallet: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .registerAgent("did:redoubt:p2-claimer", 2)
      .accounts({
        agent: claimerAgentPda,
        wallet: claimer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();

    // Fresh mint + whitelist for this test file's bounties.
    mint = await createMint(connection, payer, payer.publicKey, null, 6);

    const creatorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      creator.publicKey,
    );
    creatorTokenAccount = creatorAta.address;
    await mintTo(connection, payer, mint, creatorTokenAccount, payer, INITIAL_BALANCE);

    await program.methods
      .whitelistToken()
      .accounts({
        config: configPda,
        mint,
        tokenWhitelist: tokenWhitelistPda(mint),
        admin: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("expire_bounty_spl: anyone can expire an Open SPL bounty past deadline", async () => {
    const id = new BN(7001);
    const deadline = Math.floor(Date.now() / 1000) + 5;
    const { bounty, escrow, escrowAta } = await createSplBounty(id, deadline);

    const creatorBalanceBefore = (await getAccount(connection, creatorTokenAccount)).amount;

    await sleep(6000);

    await program.methods
      .expireBountySpl()
      .accounts({
        bounty,
        escrow,
        mint,
        escrowTokenAccount: escrowAta,
        creator: creator.publicKey,
        creatorTokenAccount,
        caller: stranger.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([stranger])
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { expired: {} });

    const creatorBalanceAfter = (await getAccount(connection, creatorTokenAccount)).amount;
    assert.equal(
      creatorBalanceAfter.toString(),
      (creatorBalanceBefore + REWARD).toString(),
      "creator should recover the full reward",
    );

    let escrowAtaClosed = false;
    try {
      await getAccount(connection, escrowAta);
    } catch (_err) {
      escrowAtaClosed = true;
    }
    assert.isTrue(escrowAtaClosed, "escrow ATA should be closed after expiry");

    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "BountyEscrow PDA should be closed after expiry");
  });

  it("expire_bounty_spl: rejects before deadline", async () => {
    const id = new BN(7002);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow, escrowAta } = await createSplBounty(id, deadline);

    let threw = false;
    try {
      await program.methods
        .expireBountySpl()
        .accounts({
          bounty,
          escrow,
          mint,
          escrowTokenAccount: escrowAta,
          creator: creator.publicKey,
          creatorTokenAccount,
          caller: stranger.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /BountyNotYetExpired/);
    }
    assert.isTrue(threw, "expected BountyNotYetExpired");
  });

  it("expire_submitted_spl: rejects before grace period elapses", async () => {
    const id = new BN(7003);
    const deadline = Math.floor(Date.now() / 1000) + 5;
    const { bounty, escrow, escrowAta } = await driveToSubmitted(id, deadline);

    await sleep(6000);

    const claimerAta = getAssociatedTokenAddressSync(mint, claimer.publicKey);
    let threw = false;
    try {
      await program.methods
        .expireSubmittedSpl()
        .accounts({
          bounty,
          escrow,
          mint,
          escrowTokenAccount: escrowAta,
          creator: creator.publicKey,
          claimer: claimer.publicKey,
          claimerTokenAccount: claimerAta,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(claimer.publicKey),
          caller: stranger.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /SubmissionGraceNotElapsed/);
    }
    assert.isTrue(threw, "expected SubmissionGraceNotElapsed");
  });

  it("resolve_dispute_spl: admin force-awards a Submitted SPL bounty to claimer", async () => {
    const id = new BN(7004);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow, escrowAta } = await driveToSubmitted(id, deadline);

    const claimerAta = getAssociatedTokenAddressSync(mint, claimer.publicKey);

    await program.methods
      .resolveDisputeSpl({ awardClaimer: {} })
      .accounts({
        bounty,
        escrow,
        mint,
        escrowTokenAccount: escrowAta,
        creator: creator.publicKey,
        creatorTokenAccount,
        claimer: claimer.publicKey,
        claimerTokenAccount: claimerAta,
        creatorReputation: reputationPda(creator.publicKey),
        claimerReputation: reputationPda(claimer.publicKey),
        config: configPda,
        admin: payer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { approved: {} });

    const claimerBalance = (await getAccount(connection, claimerAta)).amount;
    assert.isAtLeast(Number(claimerBalance), Number(REWARD));

    let escrowAtaClosed = false;
    try {
      await getAccount(connection, escrowAta);
    } catch (_err) {
      escrowAtaClosed = true;
    }
    assert.isTrue(escrowAtaClosed, "escrow ATA should be closed after resolution");
  });

  it("resolve_dispute_spl: admin force-refunds a Submitted SPL bounty to creator", async () => {
    const id = new BN(7005);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow, escrowAta } = await driveToSubmitted(id, deadline);

    const creatorBalanceBefore = (await getAccount(connection, creatorTokenAccount)).amount;
    const claimerAta = getAssociatedTokenAddressSync(mint, claimer.publicKey);

    await program.methods
      .resolveDisputeSpl({ refundCreator: {} })
      .accounts({
        bounty,
        escrow,
        mint,
        escrowTokenAccount: escrowAta,
        creator: creator.publicKey,
        creatorTokenAccount,
        claimer: claimer.publicKey,
        claimerTokenAccount: claimerAta,
        creatorReputation: reputationPda(creator.publicKey),
        claimerReputation: reputationPda(claimer.publicKey),
        config: configPda,
        admin: payer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { cancelled: {} });

    const creatorBalanceAfter = (await getAccount(connection, creatorTokenAccount)).amount;
    assert.equal(
      creatorBalanceAfter.toString(),
      (creatorBalanceBefore + REWARD).toString(),
      "creator should recover the full reward",
    );
  });

  it("resolve_dispute_spl: rejects from non-admin signer", async () => {
    const id = new BN(7006);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow, escrowAta } = await driveToSubmitted(id, deadline);

    const claimerAta = getAssociatedTokenAddressSync(mint, claimer.publicKey);
    let threw = false;
    try {
      await program.methods
        .resolveDisputeSpl({ refundCreator: {} })
        .accounts({
          bounty,
          escrow,
          mint,
          escrowTokenAccount: escrowAta,
          creator: creator.publicKey,
          creatorTokenAccount,
          claimer: claimer.publicKey,
          claimerTokenAccount: claimerAta,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(claimer.publicKey),
          config: configPda,
          admin: stranger.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotAdmin|ConstraintHasOne/);
    }
    assert.isTrue(threw, "expected non-admin to be rejected");
  });

  it("resolve_dispute_spl: rejects on Open bounty (no claimer)", async () => {
    const id = new BN(7007);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow, escrowAta } = await createSplBounty(id, deadline);

    const claimerAta = getAssociatedTokenAddressSync(mint, PublicKey.default);
    let threw = false;
    try {
      await program.methods
        .resolveDisputeSpl({ refundCreator: {} })
        .accounts({
          bounty,
          escrow,
          mint,
          escrowTokenAccount: escrowAta,
          creator: creator.publicKey,
          creatorTokenAccount,
          claimer: PublicKey.default,
          claimerTokenAccount: claimerAta,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(PublicKey.default),
          config: configPda,
          admin: payer.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      // Either the handler's status check trips (BountyAlreadyResolved) or
      // Anchor's account validation rejects the Pubkey::default claimer/ATA
      // path. Either way the call must reject; the post-call status check
      // below confirms the bounty wasn't mutated.
      assert.match(
        String(err),
        /BountyAlreadyResolved|AnchorError|ConstraintAssociated|AccountNotInitialized|caused by account/,
      );
    }
    assert.isTrue(threw, "expected Open bounty to be rejected by resolve_dispute_spl");

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(
      bountyAccount.status,
      { open: {} },
      "bounty should remain Open after rejection",
    );
  });
});
