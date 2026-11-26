import { handle, json } from "@/server/http";
import { accountJsonAll } from "@/server/payments-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/payments/account?address=0x… — a customer's balance in the payments contract, what is held for
 * their unsettled jobs, what is available for new jobs, their spend limit and any pending withdrawal. With
 * SparecycleJobPaymentsV2 on (TOKEN_PAYMENTS_V2) a `v2` block adds the V2 ETH balance, credits and SPARE balance.
 */
export const GET = handle(async (req: Request) => json(await accountJsonAll(new URL(req.url).searchParams.get("address"))));
