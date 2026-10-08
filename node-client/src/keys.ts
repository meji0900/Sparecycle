// Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) — see NOTICE.
//
// The node key: a local secp256k1 key that only signs scheduler requests and job receipts. It never holds
// funds and is never the payout account (that is the owner wallet linked with --owner / --owner-sig).
// The private key is written to the key file (mode 600) and never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

/** ~/.sparecycle-node/key.json, or SPARECYCLE_KEY_FILE (used by tests and installers run outside the home folder). */
export const DEFAULT_KEY_FILE = process.env.SPARECYCLE_KEY_FILE ?? join(homedir(), ".sparecycle-node", "key.json");

export function loadKey(file: string): PrivateKeyAccount | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { privateKey?: string };
  if (!parsed.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey)) throw new Error(`${file} does not hold a node key`);
  return privateKeyToAccount(parsed.privateKey as Hex);
}

export function loadOrCreateKey(file: string): { account: PrivateKeyAccount; created: boolean } {
  const existing = loadKey(file);
  if (existing) return { account: existing, created: false };
  mkdirSync(dirname(file), { recursive: true });
  const privateKey = generatePrivateKey();
  writeFileSync(
    file,
    JSON.stringify(
      { privateKey, note: "Sparecycle node key. It only signs for this node: never send funds to it, never share this file." },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { account: privateKeyToAccount(privateKey), created: true };
}
