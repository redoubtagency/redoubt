import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import { Redoubt } from "../target/types/redoubt";

describe("redoubt: config + admin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const guardian = Keypair.generate();
  const stranger = Keypair.generate();

  let configPda: PublicKey;

  const airdrop = async (pk: PublicKey, lamports: number) => {
    const sig = await connection.requestAirdrop(pk, lamports);
    await connection.confirmTransaction(sig, "confirmed");
  };

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );
    await airdrop(stranger.publicKey, 1 * LAMPORTS_PER_SOL);
    await airdrop(guardian.publicKey, 1 * LAMPORTS_PER_SOL);
  });

  it("initializes the config singleton", async () => {
    await program.methods
      .initializeConfig(guardian.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(config.guardian.toBase58(), guardian.publicKey.toBase58());
    assert.equal(config.paused, false);
    assert.equal(config.redoubtMint.toBase58(), PublicKey.default.toBase58());
    assert.equal(config.indexerPubkey.toBase58(), PublicKey.default.toBase58());
    assert.deepEqual(Array.from(config.redoubtTelecoinId as Uint8Array), new Array(32).fill(0));
  });

  it("rejects re-initialization", async () => {
    let threw = false;
    try {
      await program.methods
        .initializeConfig(guardian.publicKey)
        .accounts({
          config: configPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_err) {
      threw = true;
    }
    assert.isTrue(threw, "second initialize should fail");
  });

  it("admin sets token config post-launch", async () => {
    const mint = Keypair.generate().publicKey;
    const telecoinId = new Uint8Array(32);
    telecoinId.fill(7);
    const indexerKey = Keypair.generate().publicKey;

    await program.methods
      .setTokenConfig(mint, Array.from(telecoinId), indexerKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.redoubtMint.toBase58(), mint.toBase58());
    assert.equal(config.indexerPubkey.toBase58(), indexerKey.toBase58());
    assert.deepEqual(
      Array.from(config.redoubtTelecoinId as Uint8Array),
      Array.from(telecoinId),
    );
  });

  it("rejects set_token_config from non-admin", async () => {
    const mint = Keypair.generate().publicKey;
    const telecoinId = new Array(32).fill(1);
    const indexerKey = Keypair.generate().publicKey;

    let threw = false;
    try {
      await program.methods
        .setTokenConfig(mint, telecoinId, indexerKey)
        .accounts({
          config: configPda,
          admin: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotAdmin|ConstraintHasOne/);
    }
    assert.isTrue(threw, "non-admin should not be able to set token config");
  });

  it("guardian can pause", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPda,
        authority: guardian.publicKey,
      })
      .signers([guardian])
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.paused, true);
  });

  it("guardian cannot unpause", async () => {
    let threw = false;
    try {
      await program.methods
        .unpause()
        .accounts({
          config: configPda,
          admin: guardian.publicKey,
        })
        .signers([guardian])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotAdmin|ConstraintHasOne/);
    }
    assert.isTrue(threw, "guardian must not be able to unpause");
  });

  it("admin unpauses", async () => {
    await program.methods
      .unpause()
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.paused, false);
  });

  it("rejects pause from random wallet", async () => {
    let threw = false;
    try {
      await program.methods
        .pause()
        .accounts({
          config: configPda,
          authority: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotAdminOrGuardian/);
    }
    assert.isTrue(threw, "stranger must not be able to pause");
  });

  it("admin can pause directly", async () => {
    await program.methods
      .pause()
      .accounts({
        config: configPda,
        authority: admin.publicKey,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.paused, true);

    // Restore for any subsequent tests.
    await program.methods
      .unpause()
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      })
      .rpc();
  });
});
