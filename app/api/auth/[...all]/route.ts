import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";

// Better Auth endpoints, including the Authentik callback at
// /api/auth/callback/authentik. The auth instance is built per request on
// first use, so `next build` needs no secrets.
export const GET = (req: Request) => toNextJsHandler(auth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(auth()).POST(req);
