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

describe("redoubt: bounty happy path", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const creator = Keypair.generate();
  const claimer = Keypair.generate();

  const bountyId = new BN(1);
  const reward = new BN(0.5 * LAMPORTS_PER_SOL);
  const namespace = "test";
  const metadataUri = "https://example.com/bounty/1";

  let creatorAgentPda: PublicKey;
  let claimerAgentPda: PublicKey;
  let bountyPda: PublicKey;
  let escrowPda: PublicKey;
  let creatorReputationPda: PublicKey;
  let claimerReputationPda: PublicKey;

  const airdrop = async (pk: PublicKey, lamports: number) => {
    const sig = await connection.requestAirdrop(pk, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  };

  before(async () => {
    await airdrop(creator.publicKey, 5 * LAMPORTS_PER_SOL);
    await airdrop(claimer.publicKey, 1 * LAMPORTS_PER_SOL);

    [creatorAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), creator.publicKey.toBuffer()],
      program.programId,
    );
    [claimerAgentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), claimer.publicKey.toBuffer()],
      program.programId,
    );
    [bountyPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bounty"),
        creator.publicKey.toBuffer(),
        bountyId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), bountyPda.toBuffer()],
      program.programId,
    );
    [creatorReputationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), creator.publicKey.toBuffer()],
      program.programId,
    );
    [claimerReputationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation"), claimer.publicKey.toBuffer()],
      program.programId,
    );
  });

  it("registers the creator as an agent", async () => {
    await program.methods
      .registerAgent("did:redoubt:creator-1", 1)
      .accounts({
        agent: creatorAgentPda,
        wallet: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const agent = await program.account.agent.fetch(creatorAgentPda);
    assert.equal(agent.wallet.toBase58(), creator.publicKey.toBase58());
    assert.equal(agent.didUri, "did:redoubt:creator-1");
    assert.equal(agent.isActive, true);
    assert.equal(agent.isVerified, false);
    assert.equal(agent.agentType, 1);
  });

  it("registers the claimer as an agent", async () => {
    await program.methods
      .registerAgent("did:redoubt:claimer-1", 2)
      .accounts({
        agent: claimerAgentPda,
        wallet: claimer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();

    const agent = await program.account.agent.fetch(claimerAgentPda);
    assert.equal(agent.isActive, true);
    assert.equal(agent.agentType, 2);
  });

  it("creates a bounty with SOL escrow", async () => {
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .createBounty(
        bountyId,
        metadataUri,
        namespace,
        reward,
        deadline,
        PublicKey.default,
        0,
      )
      .accounts({
        bounty: bountyPda,
        escrow: escrowPda,
        creatorAgent: creatorAgentPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const bounty = await program.account.bounty.fetch(bountyPda);
    assert.equal(bounty.creator.toBase58(), creator.publicKey.toBase58());
    assert.equal(bounty.bountyId.toString(), bountyId.toString());
    assert.equal(bounty.metadataUri, metadataUri);
    assert.equal(bounty.namespace, namespace);
    assert.equal(bounty.rewardAmount.toString(), reward.toString());
    assert.deepEqual(bounty.status, { open: {} });

    const escrowBalance = await connection.getBalance(escrowPda);
    assert.isAtLeast(escrowBalance, reward.toNumber());
  });

  it("rejects a claim from a non-approved wallet when approved_claimer is set", async () => {
    // Spin up a fresh bounty with approved_claimer = creator (a wallet that won't try to claim).
    const restrictedId = new BN(2);
    const [restrictedBounty] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bounty"),
        creator.publicKey.toBuffer(),
        restrictedId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [restrictedEscrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), restrictedBounty.toBuffer()],
      program.programId,
    );
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .createBounty(
        restrictedId,
        metadataUri,
        namespace,
        new BN(0.1 * LAMPORTS_PER_SOL),
        deadline,
        creator.publicKey,
        0,
      )
      .accounts({
        bounty: restrictedBounty,
        escrow: restrictedEscrow,
        creatorAgent: creatorAgentPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .claimBounty(new BN(0))
        .accounts({
          bounty: restrictedBounty,
          claimerAgent: claimerAgentPda,
          claimer: claimer.publicKey,
          config: null,
          position: null,
          instructionsSysvar: null,
        })
        .signers([claimer])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotApprovedClaimer/);
    }
    assert.isTrue(threw, "expected claim to fail with NotApprovedClaimer");
  });

  it("claimer claims the open bounty", async () => {
    await program.methods
      .claimBounty(new BN(0))
      .accounts({
        bounty: bountyPda,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: null,
        position: null,
        instructionsSysvar: null,
      })
      .signers([claimer])
      .rpc();

    const bounty = await program.account.bounty.fetch(bountyPda);
    assert.deepEqual(bounty.status, { claimed: {} });
    assert.equal(bounty.claimer.toBase58(), claimer.publicKey.toBase58());
    assert.isAbove(bounty.claimedAt.toNumber(), 0);
  });

  it("claimer submits work", async () => {
    const submissionUri = "https://example.com/submission/1";
    const hash = crypto.createHash("sha256").update("submission body").digest();
    const submissionHash = Array.from(hash);

    await program.methods
      .submitWork(submissionUri, submissionHash)
      .accounts({
        bounty: bountyPda,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    const bounty = await program.account.bounty.fetch(bountyPda);
    assert.deepEqual(bounty.status, { submitted: {} });
    assert.equal(bounty.submissionUri, submissionUri);
    assert.deepEqual(Array.from(bounty.submissionHash as Uint8Array), submissionHash);
  });

  it("creator approves and escrow drains to claimer", async () => {
    const claimerBefore = await connection.getBalance(claimer.publicKey);

    await program.methods
      .approveBounty()
      .accounts({
        bounty: bountyPda,
        escrow: escrowPda,
        claimer: claimer.publicKey,
        creatorReputation: creatorReputationPda,
        claimerReputation: claimerReputationPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const bounty = await program.account.bounty.fetch(bountyPda);
    assert.deepEqual(bounty.status, { approved: {} });

    const claimerAfter = await connection.getBalance(claimer.publicKey);
    assert.equal(claimerAfter - claimerBefore, reward.toNumber());

    const escrowAccount = await connection.getAccountInfo(escrowPda);
    assert.isNull(escrowAccount, "escrow PDA should be closed after approval");

    const creatorRep = await program.account.agentReputation.fetch(creatorReputationPda);
    assert.equal(creatorRep.agent.toBase58(), creator.publicKey.toBase58());
    assert.equal(creatorRep.bountiesCreated.toString(), "1");
    assert.equal(creatorRep.bountiesCompleted.toString(), "0");
    assert.isAbove(creatorRep.lastBountyAt.toNumber(), 0);

    const claimerRep = await program.account.agentReputation.fetch(claimerReputationPda);
    assert.equal(claimerRep.agent.toBase58(), claimer.publicKey.toBase58());
    assert.equal(claimerRep.bountiesCompleted.toString(), "1");
    assert.equal(claimerRep.totalValueCompleted.toString(), reward.toString());
    assert.isAbove(claimerRep.lastBountyAt.toNumber(), 0);
  });
});
