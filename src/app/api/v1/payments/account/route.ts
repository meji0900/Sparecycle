import { handle, json } from "@/server/http";
import { accountJson } from "@/server/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/payments/account?address=0x… — a customer's balance in the payments contract, what is held for
 * their unsettled jobs, what is available for new jobs, their spend limit and any pending withdrawal.
 */
export const GET = handle(async (req: Request) => json(await accountJson(new URL(req.url).searchParams.get("address"))));
