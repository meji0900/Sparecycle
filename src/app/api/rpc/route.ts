// Read-only JSON-RPC relay to the chain's public RPC, used by the browser as a fallback transport. Some ISPs
// (several in Indonesia) DNS-block rpc.mainnet.chain.robinhood.com, which breaks the claim page's live reads;
// the server is not behind that block. Only read methods pass; transactions are signed and sent by the
// visitor's wallet, never through here.
import { targetChain } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const READ_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
]);
const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;

type RpcRequest = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BODY) return Response.json(rpcError(null, -32600, "request too large"), { status: 413 });
  let body: RpcRequest | RpcRequest[];
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return Response.json(rpcError(null, -32600, `batch of 1..${MAX_BATCH} calls`), { status: 400 });
  const refused = calls.find((c) => typeof c?.method !== "string" || !READ_METHODS.has(c.method));
  if (refused) return Response.json(rpcError(refused?.id, -32601, "method not allowed on this read-only relay"), { status: 400 });

  try {
    const upstream = await fetch(targetChain.rpcUrls.default.http[0], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await upstream.text(), { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json(rpcError(Array.isArray(body) ? null : body.id, -32603, "upstream RPC unreachable"), { status: 502 });
  }
}
