import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import * as crypto from "crypto";

import { Redoubt } from "../target/types/redoubt";

// Admin force-resolve. The Config singleton is initialized by config.ts (which
// runs alphabetically before this file), and config.admin is the provider's
// wallet. We exercise both ResolveDecision variants plus the rejection paths.

describe("redoubt: resolve dispute", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const creator = Keypair.generate();
  const claimer = Keypair.generate();
  const stranger = Keypair.generate();

  let creatorAgentPda: PublicKey;
  let claimerAgentPda: PublicKey;
  let configPda: PublicKey;

  const reputationPda = (wallet: PublicKey) => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), wallet.toBuffer()],
      program.programId,
    );
    return pda;
  };

  const airdrop = async (pk: PublicKey, lamports: number) => {
    const sig = await connection.requestAirdrop(pk, lamports);
    await connection.confirmTransaction(sig, "confirmed");
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

  const createBounty = async (id: BN, reward: BN) => {
    const { bounty, escrow } = bountyPdas(id);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);
    await program.methods
      .createBounty(
        id,
        "https://example.com/bounty/resolve",
        "test",
        reward,
        deadline,
        PublicKey.default,
        0,
      )
      .accounts({
        bounty,
        escrow,
        creatorAgent: creatorAgentPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    return { bounty, escrow };
  };

  const driveToSubmitted = async (id: BN, reward: BN) => {
    const { bounty, escrow } = await createBounty(id, reward);
    await program.methods
      .claimBounty(new BN(0))
      .accounts({
        bounty,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: null,
        position: null,
        instructionsSysvar: null,
      })
      .signers([claimer])
      .rpc();
    const submissionHash = Array.from(
      crypto.createHash("sha256").update(`resolve-${id.toString()}`).digest(),
    );
    await program.methods
      .submitWork("https://example.com/submission/resolve", submissionHash)
      .accounts({
        bounty,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();
    return { bounty, escrow };
  };

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );

    await airdrop(creator.publicKey, 5 * LAMPORTS_PER_SOL);
    await airdrop(claimer.publicKey, 1 * LAMPORTS_PER_SOL);
    await airdrop(stranger.publicKey, 1 * LAMPORTS_PER_SOL);

    [creatorAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), creator.publicKey.toBuffer()],
      program.programId,
    );
    [claimerAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), claimer.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .registerAgent("did:redoubt:resolve-creator", 1)
      .accounts({
        agent: creatorAgentPda,
        wallet: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .registerAgent("did:redoubt:resolve-claimer", 2)
      .accounts({
        agent: claimerAgentPda,
        wallet: claimer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();
  });

  it("admin force-awards a Submitted bounty to the claimer", async () => {
    const id = new BN(5001);
    const reward = new BN(0.4 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await driveToSubmitted(id, reward);

    const claimerBefore = await connection.getBalance(claimer.publicKey);

    await program.methods
      .resolveDispute({ awardClaimer: {} })
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
        claimer: claimer.publicKey,
        creatorReputation: reputationPda(creator.publicKey),
        claimerReputation: reputationPda(claimer.publicKey),
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { approved: {} });

    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "escrow PDA should be closed after resolution");

    const claimerAfter = await connection.getBalance(claimer.publicKey);
    assert.equal(
      claimerAfter - claimerBefore,
      reward.toNumber(),
      "claimer should receive the full reward",
    );

    const creatorRep = await program.account.agentReputation.fetch(
      reputationPda(creator.publicKey),
    );
    assert.equal(creatorRep.bountiesCreated.toString(), "1");
    const claimerRep = await program.account.agentReputation.fetch(
      reputationPda(claimer.publicKey),
    );
    assert.equal(claimerRep.bountiesCompleted.toString(), "1");
    assert.equal(claimerRep.totalValueCompleted.toString(), reward.toString());
  });

  it("admin force-refunds a Submitted bounty to the creator", async () => {
    const id = new BN(5002);
    const reward = new BN(0.3 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await driveToSubmitted(id, reward);

    const escrowBefore = await connection.getBalance(escrow);
    const creatorBefore = await connection.getBalance(creator.publicKey);

    await program.methods
      .resolveDispute({ refundCreator: {} })
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
        claimer: claimer.publicKey,
        creatorReputation: reputationPda(creator.publicKey),
        claimerReputation: reputationPda(claimer.publicKey),
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { cancelled: {} });

    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "escrow PDA should be closed after resolution");

    const creatorAfter = await connection.getBalance(creator.publicKey);
    assert.equal(
      creatorAfter - creatorBefore,
      escrowBefore,
      "creator should recover full escrow balance",
    );
  });

  it("admin refunds an Open (unclaimed) bounty to the creator", async () => {
    const id = new BN(5003);
    const reward = new BN(0.2 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createBounty(id, reward);

    const escrowBefore = await connection.getBalance(escrow);
    const creatorBefore = await connection.getBalance(creator.publicKey);

    // Bounty is Open — bounty.claimer is Pubkey::default(), so the claimer_reputation
    // PDA the program expects is derived from the zero key, not from claimer.publicKey.
    await program.methods
      .resolveDispute({ refundCreator: {} })
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
        claimer: claimer.publicKey,
        creatorReputation: reputationPda(creator.publicKey),
        claimerReputation: reputationPda(PublicKey.default),
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { cancelled: {} });

    const creatorAfter = await connection.getBalance(creator.publicKey);
    assert.equal(creatorAfter - creatorBefore, escrowBefore);
  });

  it("rejects AwardClaimer on a never-claimed bounty", async () => {
    const id = new BN(5004);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createBounty(id, reward);

    let threw = false;
    try {
      // Bounty is Open: bounty.claimer is Pubkey::default(), seeds derive from it.
      await program.methods
        .resolveDispute({ awardClaimer: {} })
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          claimer: claimer.publicKey,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(PublicKey.default),
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /BountyNotClaimed/);
    }
    assert.isTrue(threw, "expected resolve to fail with BountyNotClaimed");
  });

  it("rejects resolve from a non-admin signer", async () => {
    const id = new BN(5005);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createBounty(id, reward);

    let threw = false;
    try {
      // Bounty is Open: claimer_reputation PDA is for Pubkey::default().
      await program.methods
        .resolveDispute({ refundCreator: {} })
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          claimer: claimer.publicKey,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(PublicKey.default),
          config: configPda,
          admin: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotAdmin|ConstraintHasOne/);
    }
    assert.isTrue(threw, "expected resolve to fail without admin authority");
  });

  it("rejects resolve when bounty is already in a terminal status", async () => {
    // Drive the bounty to Cancelled via cancel_bounty, then try to resolve again.
    const id = new BN(5006);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createBounty(id, reward);

    await program.methods
      .cancelBounty()
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .resolveDispute({ refundCreator: {} })
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          claimer: claimer.publicKey,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(claimer.publicKey),
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      // Escrow PDA is already closed by cancel — expect either AccountNotInitialized
      // (Anchor failing to deserialize the closed escrow) or BountyAlreadyResolved
      // depending on which check trips first. Both are valid terminal-state rejections.
      assert.match(
        String(err),
        /BountyAlreadyResolved|AccountNotInitialized|AccountOwnedByWrongProgram/,
      );
    }
    assert.isTrue(threw, "expected resolve to fail on terminal-status bounty");
  });
});
