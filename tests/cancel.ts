import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";

import { Redoubt } from "../target/types/redoubt";

describe("redoubt: cancel bounty", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const creator = Keypair.generate();
  const claimer = Keypair.generate();
  const stranger = Keypair.generate();

  let creatorAgentPda: PublicKey;
  let claimerAgentPda: PublicKey;

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

  const createOpenBounty = async (id: BN, reward: BN) => {
    const { bounty, escrow } = bountyPdas(id);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);
    await program.methods
      .createBounty(
        id,
        "https://example.com/bounty/cancel",
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

    await program.methods
      .registerAgent("did:redoubt:cancel-creator", 1)
      .accounts({
        agent: creatorAgentPda,
        wallet: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .registerAgent("did:redoubt:cancel-claimer", 2)
      .accounts({
        agent: claimerAgentPda,
        wallet: claimer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();
  });

  it("creator cancels an open bounty and escrow returns to creator", async () => {
    const id = new BN(3001);
    const reward = new BN(0.4 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createOpenBounty(id, reward);

    const escrowBefore = await connection.getBalance(escrow);
    assert.isAtLeast(escrowBefore, reward.toNumber());
    const creatorBefore = await connection.getBalance(creator.publicKey);

    const sig = await program.methods
      .cancelBounty()
      .accounts({
        bounty,
        escrow,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const fee = tx?.meta?.fee ?? 0;

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { cancelled: {} });

    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "escrow PDA should be closed after cancel");

    const creatorAfter = await connection.getBalance(creator.publicKey);
    assert.equal(
      creatorAfter - creatorBefore,
      escrowBefore - fee,
      "creator should recover full escrow balance minus tx fee",
    );
  });

  it("rejects cancel from a non-creator", async () => {
    const id = new BN(3002);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createOpenBounty(id, reward);

    let threw = false;
    try {
      await program.methods
        .cancelBounty()
        .accounts({
          bounty,
          escrow,
          creator: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotCreator/);
    }
    assert.isTrue(threw, "expected cancel to fail with NotCreator");
  });

  it("rejects cancel after the bounty has been claimed", async () => {
    const id = new BN(3003);
    const reward = new BN(0.1 * LAMPORTS_PER_SOL);
    const { bounty, escrow } = await createOpenBounty(id, reward);

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

    let threw = false;
    try {
      await program.methods
        .cancelBounty()
        .accounts({
          bounty,
          escrow,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /BountyNotOpen/);
    }
    assert.isTrue(threw, "expected cancel to fail with BountyNotOpen");
  });
});
