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

// SPL escrow Phase 1: create + approve + cancel happy paths, whitelist enforcement,
// and cross-type rejection (SOL handler on SPL bounty and vice versa). The expire
// and resolve_dispute SPL variants are deferred to Phase 2.

describe("redoubt: spl escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Redoubt as Program<Redoubt>;
  const connection = provider.connection;

  const payer = (provider.wallet as anchor.Wallet).payer; // also the admin (set by config.ts)
  const creator = Keypair.generate();
  const claimer = Keypair.generate();

  let creatorAgentPda: PublicKey;
  let claimerAgentPda: PublicKey;
  let configPda: PublicKey;

  let mint: PublicKey;
  let mintAllowed: PublicKey;
  let mintForbidden: PublicKey;

  let creatorTokenAccount: PublicKey;
  let claimerTokenAccount: PublicKey;

  const REWARD = 1_000_000n; // 1.0 token assuming 6 decimals
  const INITIAL_BALANCE = 10_000_000n; // 10 tokens

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

    await program.methods
      .registerAgent("did:redoubt:spl-creator", 1)
      .accounts({
        agent: creatorAgentPda,
        wallet: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .registerAgent("did:redoubt:spl-claimer", 2)
      .accounts({
        agent: claimerAgentPda,
        wallet: claimer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();

    // Create two mints: one we'll whitelist, one we deliberately won't.
    mintAllowed = await createMint(connection, payer, payer.publicKey, null, 6);
    mintForbidden = await createMint(connection, payer, payer.publicKey, null, 6);
    mint = mintAllowed;

    // Fund the creator's ATA with both mints; they'll need the allowed one for the
    // happy paths, and we'll attempt the forbidden mint to test whitelist enforcement.
    const creatorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintAllowed,
      creator.publicKey,
    );
    creatorTokenAccount = creatorAta.address;
    await mintTo(connection, payer, mintAllowed, creatorTokenAccount, payer, INITIAL_BALANCE);

    const creatorForbiddenAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintForbidden,
      creator.publicKey,
    );
    await mintTo(
      connection,
      payer,
      mintForbidden,
      creatorForbiddenAta.address,
      payer,
      INITIAL_BALANCE,
    );

    // Pre-derive (don't create) claimer ATA for the allowed mint; approve_bounty_spl
    // will init_if_needed it.
    claimerTokenAccount = getAssociatedTokenAddressSync(mintAllowed, claimer.publicKey);
  });

  it("admin whitelists a token mint", async () => {
    await program.methods
      .whitelistToken()
      .accounts({
        config: configPda,
        mint: mintAllowed,
        tokenWhitelist: tokenWhitelistPda(mintAllowed),
        admin: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.tokenWhitelist.fetch(
      tokenWhitelistPda(mintAllowed),
    );
    assert.equal(entry.mint.toBase58(), mintAllowed.toBase58());
  });

  it("rejects whitelist_token from non-admin", async () => {
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1 * LAMPORTS_PER_SOL);

    let threw = false;
    try {
      await program.methods
        .whitelistToken()
        .accounts({
          config: configPda,
          mint: mintForbidden,
          tokenWhitelist: tokenWhitelistPda(mintForbidden),
          admin: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /NotAdmin|ConstraintHasOne/);
    }
    assert.isTrue(threw, "non-admin must not be able to whitelist tokens");
  });

  it("creates an SPL bounty, claims, submits, and approves end-to-end", async () => {
    const id = new BN(6001);
    const { bounty, escrow } = bountyPdas(id);
    const escrowAta = getAssociatedTokenAddressSync(mint, escrow, true);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .createBountySpl(
        id,
        "https://example.com/bounty/spl",
        "test",
        new BN(REWARD.toString()),
        deadline,
        PublicKey.default,
        0,
      )
      .accounts({
        bounty,
        escrow,
        creatorAgent: creatorAgentPda,
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

    const bountyAccount = await program.account.bounty.fetch(bounty);
    assert.deepEqual(bountyAccount.status, { open: {} });
    assert.deepEqual(bountyAccount.escrowType, { splToken: {} });
    assert.equal(bountyAccount.escrowMint.toBase58(), mint.toBase58());

    const escrowAtaInfo = await getAccount(connection, escrowAta);
    assert.equal(escrowAtaInfo.amount.toString(), REWARD.toString());

    // Claim
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

    // Submit
    const submissionHash = Array.from(
      crypto.createHash("sha256").update("spl-test").digest(),
    );
    await program.methods
      .submitWork("https://example.com/submission/spl", submissionHash)
      .accounts({
        bounty,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    // Approve (SPL variant)
    await program.methods
      .approveBountySpl()
      .accounts({
        bounty,
        escrow,
        mint,
        escrowTokenAccount: escrowAta,
        claimer: claimer.publicKey,
        claimerTokenAccount,
        creatorReputation: reputationPda(creator.publicKey),
        claimerReputation: reputationPda(claimer.publicKey),
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    const finalBounty = await program.account.bounty.fetch(bounty);
    assert.deepEqual(finalBounty.status, { approved: {} });

    const claimerAtaInfo = await getAccount(connection, claimerTokenAccount);
    assert.equal(claimerAtaInfo.amount.toString(), REWARD.toString());

    // Escrow ATA should be closed (token::close_account).
    let escrowAtaClosed = false;
    try {
      await getAccount(connection, escrowAta);
    } catch (_err) {
      escrowAtaClosed = true;
    }
    assert.isTrue(escrowAtaClosed, "escrow ATA should be closed after approval");

    // BountyEscrow PDA should be closed (Anchor close = creator).
    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "BountyEscrow PDA should be closed after approval");
  });

  it("creator cancels an SPL bounty and tokens return", async () => {
    const id = new BN(6002);
    const { bounty, escrow } = bountyPdas(id);
    const escrowAta = getAssociatedTokenAddressSync(mint, escrow, true);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    const creatorBalanceBefore = (await getAccount(connection, creatorTokenAccount)).amount;

    await program.methods
      .createBountySpl(
        id,
        "https://example.com/bounty/spl-cancel",
        "test",
        new BN(REWARD.toString()),
        deadline,
        PublicKey.default,
        0,
      )
      .accounts({
        bounty,
        escrow,
        creatorAgent: creatorAgentPda,
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

    await program.methods
      .cancelBountySpl()
      .accounts({
        bounty,
        escrow,
        mint,
        escrowTokenAccount: escrowAta,
        creatorTokenAccount,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    const finalBounty = await program.account.bounty.fetch(bounty);
    assert.deepEqual(finalBounty.status, { cancelled: {} });

    const creatorBalanceAfter = (await getAccount(connection, creatorTokenAccount)).amount;
    assert.equal(
      creatorBalanceAfter.toString(),
      creatorBalanceBefore.toString(),
      "creator should have full token balance restored",
    );

    const escrowAccount = await connection.getAccountInfo(escrow);
    assert.isNull(escrowAccount, "BountyEscrow PDA should be closed after cancel");
  });

  it("rejects create_bounty_spl with a non-whitelisted mint", async () => {
    const id = new BN(6003);
    const { bounty, escrow } = bountyPdas(id);
    const escrowAta = getAssociatedTokenAddressSync(mintForbidden, escrow, true);
    const creatorForbiddenAta = getAssociatedTokenAddressSync(
      mintForbidden,
      creator.publicKey,
    );
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    let threw = false;
    try {
      await program.methods
        .createBountySpl(
          id,
          "https://example.com/bounty/spl-forbidden",
          "test",
          new BN(REWARD.toString()),
          deadline,
          PublicKey.default,
          0,
        )
        .accounts({
          bounty,
          escrow,
          creatorAgent: creatorAgentPda,
          mint: mintForbidden,
          tokenWhitelist: tokenWhitelistPda(mintForbidden),
          creatorTokenAccount: creatorForbiddenAta,
          escrowTokenAccount: escrowAta,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();
    } catch (err: any) {
      threw = true;
      // Token whitelist PDA doesn't exist → AccountNotInitialized; or seed mismatch.
      assert.match(
        String(err),
        /TokenNotWhitelisted|AccountNotInitialized|ConstraintSeeds/,
      );
    }
    assert.isTrue(threw, "create_bounty_spl with non-whitelisted mint must fail");
  });

  it("rejects approve_bounty (SOL handler) on an SPL bounty", async () => {
    // Create another SPL bounty, drive it to Submitted, then call the SOL approve.
    const id = new BN(6004);
    const { bounty, escrow } = bountyPdas(id);
    const escrowAta = getAssociatedTokenAddressSync(mint, escrow, true);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .createBountySpl(
        id,
        "https://example.com/bounty/cross",
        "test",
        new BN(REWARD.toString()),
        deadline,
        PublicKey.default,
        0,
      )
      .accounts({
        bounty,
        escrow,
        creatorAgent: creatorAgentPda,
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
      crypto.createHash("sha256").update("cross").digest(),
    );
    await program.methods
      .submitWork("https://example.com/submission/cross", submissionHash)
      .accounts({
        bounty,
        claimer: claimer.publicKey,
      })
      .signers([claimer])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .approveBounty()
        .accounts({
          bounty,
          escrow,
          claimer: claimer.publicKey,
          creatorReputation: reputationPda(creator.publicKey),
          claimerReputation: reputationPda(claimer.publicKey),
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /WrongEscrowType/);
    }
    assert.isTrue(threw, "SOL approve must reject SPL bounty");

    // Clean up: cancel the bounty so escrow is freed (status is Submitted, can't cancel).
    // Skip cleanup; bounty remains in Submitted state, doesn't affect other tests.
  });
});
