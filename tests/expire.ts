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

// Time-based expiry tests. We can exercise the "before deadline" reject paths
// against a vanilla local validator, plus the happy path for `expire_bounty`
// using short deadlines + a real-time wait. The `expire_submitted` happy path
// requires waiting `deadline + SUBMISSION_GRACE_SECONDS` (7 days in production)
// — that needs LiteSVM-style clock control and is deferred until that scaffolding
// lands. We cover the "before grace" reject path here.

describe("redoubt: bounty expiry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const createBounty = async (id: BN, reward: BN, deadlineSec: number) => {
    const { bounty, escrow } = bountyPdas(id);
    await program.methods
      .createBounty(
        id,
        "https://example.com/bounty/expire",
        "test",
        reward,
        new BN(deadlineSec),
        PublicKey.default,
        0,
      )
      .accounts({
        bounty,
        escrow,
        creatorAgent: creatorAgentPda,
        config: configPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    return { bounty, escrow };
  };

  before(async () => {
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
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );

    await program.methods
      .registerAgent("did:redoubt:expire-creator", 1)
      .accounts({
        agent: creatorAgentPda,
        wallet: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .registerAgent("did:redoubt:expire-claimer", 2)
      .accounts({
        agent: claimerAgentPda,
        wallet: claimer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();
  });

  it("expire_bounty: anyone can expire an Open bounty past deadline", async () => {
    const id = new BN(4001);
    const reward = new BN(0.3 * LAMPORTS_PER_SOL);
    const deadline = Math.floor(Date.now() / 1000) + 2;
    const { bounty, escrow } = await createBounty(id, reward, deadline);

    const escrowBefore = await connection.getBalance(escrow);
    const creatorBefore = await connection.getBalance(creator.publicKey);

    await sleep(3000);

    await program.methods
      .expireBounty()
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
        caller: stranger.publicKey,
      })
      .signers([stranger])
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { expired: {} });

    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "escrow PDA should be closed after expiry");

    const creatorAfter = await connection.getBalance(creator.publicKey);
    assert.equal(
      creatorAfter - creatorBefore,
      escrowBefore,
      "creator should recover full escrow balance (caller paid the tx fee)",
    );
  });

  it("expire_bounty: anyone can expire a Claimed bounty past deadline", async () => {
    const id = new BN(4002);
    const reward = new BN(0.2 * LAMPORTS_PER_SOL);
    const deadline = Math.floor(Date.now() / 1000) + 2;
    const { bounty, escrow } = await createBounty(id, reward, deadline);

    await program.methods
      .claimBounty(new BN(0))
      .accounts({
        bounty,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: configPda,
        position: null,
        instructionsSysvar: null,
      })
      .signers([claimer])
      .rpc();

    await sleep(3000);

    await program.methods
      .expireBounty()
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
        caller: stranger.publicKey,
      })
      .signers([stranger])
      .rpc();

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { expired: {} });
  });

  it("expire_bounty: rejects before deadline", async () => {
    const id = new BN(4003);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow } = await createBounty(id, reward, deadline);

    let threw = false;
    try {
      await program.methods
        .expireBounty()
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          caller: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /BountyNotYetExpired/);
    }
    assert.isTrue(threw, "expected expire_bounty to fail with BountyNotYetExpired");
  });

  it("expire_bounty: rejects when bounty status is not Open or Claimed", async () => {
    const id = new BN(4004);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow } = await createBounty(id, reward, deadline);

    // Drive bounty to Submitted (not Open or Claimed).
    await program.methods
      .claimBounty(new BN(0))
      .accounts({
        bounty,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: configPda,
        position: null,
        instructionsSysvar: null,
      })
      .signers([claimer])
      .rpc();

    const submissionHash = Array.from(
      crypto.createHash("sha256").update("expired-test").digest(),
    );
    await program.methods
      .submitWork("https://example.com/submission", submissionHash)
      .accounts({
        bounty,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .expireBounty()
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          caller: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /BountyNotExpirable/);
    }
    assert.isTrue(threw, "expected expire_bounty to fail with BountyNotExpirable");
  });

  it("expire_submitted: rejects before grace period elapses", async () => {
    // Bounty in Submitted state, deadline already passed but grace (7d) not elapsed.
    const id = new BN(4005);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const deadline = Math.floor(Date.now() / 1000) + 2;
    const { bounty, escrow } = await createBounty(id, reward, deadline);

    await program.methods
      .claimBounty(new BN(0))
      .accounts({
        bounty,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: configPda,
        position: null,
        instructionsSysvar: null,
      })
      .signers([claimer])
      .rpc();

    const submissionHash = Array.from(
      crypto.createHash("sha256").update("grace-test").digest(),
    );
    await program.methods
      .submitWork("https://example.com/submission/grace", submissionHash)
      .accounts({
        bounty,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    await sleep(3000);

    let threw = false;
    try {
      await program.methods
        .expireSubmitted()
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          claimer: claimer.publicKey,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(claimer.publicKey),
          caller: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /SubmissionGraceNotElapsed/);
    }
    assert.isTrue(threw, "expected expire_submitted to fail with SubmissionGraceNotElapsed");
  });

  it("expire_submitted: rejects when bounty is Claimed but not Submitted", async () => {
    const id = new BN(4006);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const { bounty, escrow } = await createBounty(id, reward, deadline);

    // Drive bounty to Claimed (so claimer matches) but stop short of Submitted.
    await program.methods
      .claimBounty(new BN(0))
      .accounts({
        bounty,
        claimerAgent: claimerAgentPda,
        claimer: claimer.publicKey,
        config: configPda,
        position: null,
        instructionsSysvar: null,
      })
      .signers([claimer])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .expireSubmitted()
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
          claimer: claimer.publicKey,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(claimer.publicKey),
          caller: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /BountyNotSubmitted/);
    }
    assert.isTrue(threw, "expected expire_submitted to fail with BountyNotSubmitted");
  });
});
