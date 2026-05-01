/**
 * Register the caller as an agent and post a SOL bounty.
 *
 * Usage:
 *   PROGRAM_ID=<deployed_program_id> \
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   WALLET_KEYPAIR=~/.config/solana/id.json \
 *   ts-node examples/create-bounty.ts
 *
 * Requires `anchor build` to have been run (imports the generated IDL and types
 * from target/). Requires Config to have been initialized on the target cluster
 * — run `anchor test` once on localnet, or call `initialize_config` directly.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

import idl from "../target/idl/redoubt.json";
import type { Redoubt } from "../target/types/redoubt";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "AV7aXKi6SNDG8TinRotfUrTj87d1ydHzc7RwxGhTeYt2",
);
const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const KEYPAIR_PATH = (process.env.WALLET_KEYPAIR ?? "~/.config/solana/id.json")
  .replace(/^~(?=$|\/|\\)/, os.homedir());

function loadKeypair(p: string): Keypair {
  const bytes = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main() {
  const wallet = new anchor.Wallet(loadKeypair(KEYPAIR_PATH));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlWithAddress = { ...(idl as any), address: PROGRAM_ID.toBase58() };
  const program = new Program(idlWithAddress, provider) as Program<Redoubt>;

  console.log(`program  ${PROGRAM_ID.toBase58()}`);
  console.log(`cluster  ${RPC_URL}`);
  console.log(`wallet   ${wallet.publicKey.toBase58()}`);

  const [agentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), wallet.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );

  const existing = await connection.getAccountInfo(agentPda);
  if (!existing) {
    console.log(`registering agent ${agentPda.toBase58()}`);
    await program.methods
      .registerAgent("did:redoubt:example", 1)
      .accounts({
        agent: agentPda,
        wallet: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } else {
    console.log(`agent already registered ${agentPda.toBase58()}`);
  }

  const bountyId = new BN(Date.now());
  const reward = new BN(0.01 * LAMPORTS_PER_SOL);
  const deadline = new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);

  const [bountyPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("bounty"),
      wallet.publicKey.toBuffer(),
      bountyId.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), bountyPda.toBuffer()],
    PROGRAM_ID,
  );

  console.log(`creating bounty ${bountyPda.toBase58()}`);

  const sig = await program.methods
    .createBounty(
      bountyId,
      "https://example.com/bounty/1",
      "example",
      reward,
      deadline,
      PublicKey.default, // approved_claimer = default → open to anyone
    )
    .accounts({
      bounty: bountyPda,
      escrow: escrowPda,
      creatorAgent: agentPda,
      config: configPda,
      creator: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`tx       ${sig}`);

  const bounty = await program.account.bounty.fetch(bountyPda);
  console.log(`status   ${Object.keys(bounty.status)[0]}`);
  console.log(`reward   ${bounty.rewardAmount.toString()} lamports`);
  console.log(`deadline ${new Date(bounty.deadline.toNumber() * 1000).toISOString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
