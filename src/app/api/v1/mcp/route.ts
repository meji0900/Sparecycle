import { PRIVATE_HEADERS } from "@/server/http";
import { handleMcp } from "@/server/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/mcp (also /v1/mcp) — the Sparecycle MCP server: Streamable HTTP, stateless, JSON responses,
 * `Authorization: Bearer sck_…` on every request. Tools: submit_job, get_job_status, get_job_result, get_balance.
 * See src/server/mcp.ts and /docs/api/mcp.
 */
export const POST = async (req: Request) => {
  try {
    return await handleMcp(req);
  } catch (e) {
    console.error(`[sparecycle] mcp internal error: ${e instanceof Error ? e.message : String(e)}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", ...PRIVATE_HEADERS },
    });
  }
};

/** No standalone SSE stream and no sessions in this server: GET and DELETE answer 405. */
const notAllowed = async () => new Response(null, { status: 405, headers: { allow: "POST", ...PRIVATE_HEADERS } });
export const GET = notAllowed;
export const DELETE = notAllowed;
