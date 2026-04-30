import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { assert } from "chai";

import { Redoubt } from "../target/types/redoubt";

// Tier-gated claim_bounty exercises the optional config / position / instructions_sysvar
// account branch in the program. A full happy-path test requires injecting an account
// owned by the Printr staking program, which the local validator can't do without
// LiteSVM-style account preloading. These tests cover the failure paths reachable
// without foreign-program-owned accounts.

describe("redoubt: tier-gated claim", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const creator = Keypair.generate();
  const claimer = Keypair.generate();

  const bountyId = new BN(1001);
  const reward = new BN(0.1 * LAMPORTS_PER_SOL);

  let creatorAgentPda: PublicKey;
  let claimerAgentPda: PublicKey;
  let bountyPda: PublicKey;
  let escrowPda: PublicKey;
  let configPda: PublicKey;

  const airdrop = async (pk: PublicKey, lamports: number) => {
    const sig = await connection.requestAirdrop(pk, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  };

  const ensureAgent = async (wallet: Keypair, pda: PublicKey, did: string, kind: number) => {
    const existing = await connection.getAccountInfo(pda);
    if (existing) return;
    await program.methods
      .registerAgent(did, kind)
      .accounts({
        agent: pda,
        wallet: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
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
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );

    await ensureAgent(creator, creatorAgentPda, "did:redoubt:tier-creator", 1);
    await ensureAgent(claimer, claimerAgentPda, "did:redoubt:tier-claimer", 2);

    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);
    await program.methods
      .createBounty(
        bountyId,
        "https://example.com/bounty/tier",
        "test-tier",
        reward,
        deadline,
        PublicKey.default,
        3, // require T3 (lock_period_index >= 2)
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
  });

  it("rejects claim with no config when tier is required", async () => {
    let threw = false;
    try {
      await program.methods
        .claimBounty(new BN(Math.floor(Date.now() / 1000) + 600))
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
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /ConfigRequired/);
    }
    assert.isTrue(threw, "expected ConfigRequired");
  });

  it("rejects claim with no position when tier is required", async () => {
    let threw = false;
    try {
      await program.methods
        .claimBounty(new BN(Math.floor(Date.now() / 1000) + 600))
        .accounts({
          bounty: bountyPda,
          claimerAgent: claimerAgentPda,
          claimer: claimer.publicKey,
          config: configPda,
          position: null,
          instructionsSysvar: null,
        })
        .signers([claimer])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /PositionRequired/);
    }
    assert.isTrue(threw, "expected PositionRequired");
  });

  it("rejects claim with no instructions sysvar when tier is required", async () => {
    const fakePosition = Keypair.generate().publicKey;
    let threw = false;
    try {
      await program.methods
        .claimBounty(new BN(Math.floor(Date.now() / 1000) + 600))
        .accounts({
          bounty: bountyPda,
          claimerAgent: claimerAgentPda,
          claimer: claimer.publicKey,
          config: configPda,
          position: fakePosition,
          instructionsSysvar: null,
        })
        .signers([claimer])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /InstructionsSysvarRequired/);
    }
    assert.isTrue(threw, "expected InstructionsSysvarRequired");
  });

  it("rejects claim when position is not owned by the Printr program", async () => {
    // System-owned account (the claimer wallet) — fails the owner check before
    // any signature work can happen.
    let threw = false;
    try {
      await program.methods
        .claimBounty(new BN(Math.floor(Date.now() / 1000) + 600))
        .accounts({
          bounty: bountyPda,
          claimerAgent: claimerAgentPda,
          claimer: claimer.publicKey,
          config: configPda,
          position: claimer.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([claimer])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /PositionWrongOwner/);
    }
    assert.isTrue(threw, "expected PositionWrongOwner");
  });
});
