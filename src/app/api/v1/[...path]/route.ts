import { errorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unknown /api/v1 paths answer with a JSON 404 instead of an HTML page. */
const notFound = async () => errorResponse(404, "not-found", "no such scheduler endpoint");

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
