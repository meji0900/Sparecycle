#!/usr/bin/env node
// A real x402 client for the live API: one job paid with a signed USDG transfer, no API key.
//
//   node scripts/x402-pay.mjs init                      create the payer wallet in .keys/x402-payer.json (prints only
//                                                       the address; send it a little USDG, it needs no ETH)
//   node scripts/x402-pay.mjs image "a prompt"          402 -> sign EIP-3009 -> paid retry -> poll -> save the PNG
//   node scripts/x402-pay.mjs text "a question"
//
// Env: SPARECYCLE_API (default https://sparecycle.tech/v1). The read secret is kept in .keys/x402-last.json and shown
// masked. A transcript of every request and answer (secret masked) goes to data/x402-runs/<time>/run.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = join(ROOT, ".keys", "x402-payer.json");
const LAST_FILE = join(ROOT, ".keys", "x402-last.json");
const API = (process.env.SPARECYCLE_API ?? "https://sparecycle.tech/v1").replace(/\/+$/, "");
const CHAIN_ID = 4663;
const mask = (s) => (typeof s === "string" && s.length > 8 ? `${s.slice(0, 4)}…(masked)` : "…(masked)");

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "init") {
  if (existsSync(KEY_FILE)) {
    console.log(`Payer wallet already exists: ${JSON.parse(readFileSync(KEY_FILE, "utf8")).address}`);
  } else {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    writeFileSync(KEY_FILE, JSON.stringify({ address, privateKey }, null, 2) + "\n", { mode: 0o600 });
    console.log(`Payer wallet: ${address}\nSend it a little USDG (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) on Robinhood Chain. It needs no ETH.`);
  }
  process.exit(0);
}
if (!["image", "text"].includes(cmd)) {
  console.log('usage: node scripts/x402-pay.mjs init | image "prompt" | text "question"');
  process.exit(1);
}
if (!existsSync(KEY_FILE)) throw new Error("No payer wallet: node scripts/x402-pay.mjs init");
const who = privateKeyToAccount(JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey);
const xl = await srcImport("lib/x402.ts");
const prompt = rest.join(" ") || (cmd === "image" ? "a lighthouse on a rocky coast at dusk, oil painting" : "In one sentence, why do two machines check each job?");
const path = cmd === "image" ? "/images/generations" : "/chat/completions";
const body =
  cmd === "image"
    ? { model: "sd15", prompt, size: "512x512", n: 1, response_format: "b64_json" }
    : { model: "qwen2.5-1.5b", messages: [{ role: "user", content: prompt }], max_tokens: 96 };
const runDir = join(ROOT, "data", "x402-runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(runDir, { recursive: true });
const log = [];
const t0 = Date.now();
const record = (step, data) => {
  log.push({ step, ms: Date.now() - t0, ...data });
  writeFileSync(join(runDir, "run.json"), JSON.stringify(log, null, 2));
};

async function call(method, url, json, headers = {}) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: json ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 300);
  }
  return { status: res.status, headers: res.headers, data };
}

// 1. Ask without a key: 402 with PAYMENT-REQUIRED.
const first = await call("POST", API + path, body);
const header = first.headers.get("payment-required");
const pr = header ? xl.decodeX402Header(header) : null;
const r = pr?.accepts?.[0];
record("ask", { request: { method: "POST", url: API + path, body }, status: first.status, error: first.data?.error ?? null, paymentRequired: pr });
console.log(`1. POST ${path} (no key) -> ${first.status}${first.data?.error?.code ? ` ${first.data.error.code}` : ""}`);
if (first.status !== 402 || !r) {
  console.log(JSON.stringify(first.data, null, 2));
  process.exit(1);
}
console.log(`   price ${Number(r.amount) / 1e6} USDG (${r.amount} base units), network ${r.network}, payTo ${r.payTo} (the escrow)`);

// 2. Sign a TransferWithAuthorization for exactly that amount to the escrow, and retry with PAYMENT-SIGNATURE.
const authorization = {
  from: who.address,
  to: r.payTo,
  value: r.amount,
  validAfter: "0",
  validBefore: String(Math.floor(Date.now() / 1000) + Number(r.maxTimeoutSeconds)),
  nonce: generatePrivateKey(),
};
const signature = await who.signTypedData({
  domain: xl.assetDomain(r, CHAIN_ID),
  types: xl.TRANSFER_WITH_AUTHORIZATION_TYPES,
  primaryType: "TransferWithAuthorization",
  message: xl.authorizationMessage(authorization),
});
const paid = await call("POST", API + path, body, {
  "payment-signature": xl.encodeX402Header({ x402Version: 2, accepted: r, payload: { signature, authorization } }),
});
const responseHeader = paid.headers.get("payment-response");
const paymentResponse = responseHeader ? xl.decodeX402Header(responseHeader) : null;
const sc = paid.data?.sparecycle ?? {};
const secret = sc.read_secret;
if (secret) writeFileSync(LAST_FILE, JSON.stringify({ job: sc.job_id, readSecret: secret, poll: sc.poll }, null, 2), { mode: 0o600 });
record("pay", {
  status: paid.status,
  paymentResponse,
  sparecycle: { ...sc, read_secret: secret ? mask(secret) : undefined },
  error: paid.data?.error ?? null,
});
console.log(`2. paid retry -> ${paid.status}; funding tx ${paymentResponse?.transaction ?? "?"}; job ${sc.job_id ?? "?"}; read secret ${mask(secret)}`);
if (paid.status >= 300 || !sc.poll || !secret) {
  console.log(JSON.stringify(paid.data, null, 2));
  process.exit(1);
}

// 3. Poll with the read secret until the two results are compared.
const pollUrl = sc.poll.startsWith("http") ? sc.poll : new URL(sc.poll, API).toString();
let last = null;
for (let i = 0; i < 40; i++) {
  last = await call("GET", pollUrl, null, { authorization: `Bearer ${secret}`, prefer: "wait=25" });
  const st = last.data?.sparecycle?.status ?? last.data?.status;
  record("poll", { status: last.status, jobStatus: st, error: last.data?.error ?? null });
  console.log(`3. poll -> ${last.status} ${st ?? ""}`);
  if (last.status !== 202) break;
}
const out = last?.data;
const final = out?.sparecycle ?? {};
record("result", { status: last?.status, sparecycle: { ...final, read_secret: undefined }, error: out?.error ?? null });
if (cmd === "image" && out?.data?.[0]?.b64_json) {
  writeFileSync(join(runDir, "result.png"), Buffer.from(out.data[0].b64_json, "base64"));
  console.log(`4. image saved: ${join(runDir, "result.png")}`);
} else if (cmd === "text" && out?.choices?.[0]?.message?.content) {
  writeFileSync(join(runDir, "answer.txt"), out.choices[0].message.content);
  console.log(`4. answer: ${out.choices[0].message.content}`);
} else {
  console.log(JSON.stringify(out, null, 2).slice(0, 1200));
}
console.log(`   receipt ${final.receipt_url ?? "?"}\n   transcript ${join(runDir, "run.json")}`);
