import { disableAllKeys, sessionOwner } from "@/server/apikeys";
import { handlePrivate, privateJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/keys/disable-all — disables every active key of the signed-in wallet (kill switch). Session only. */
export const POST = handlePrivate(async (req: Request) => privateJson(disableAllKeys(sessionOwner(req))));
