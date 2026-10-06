import { sql } from "kysely";
import { connection } from "next/server";
import { db } from "@/server/db";

export async function GET() {
  await connection();
  try {
    await sql`select 1`.execute(db());
    return Response.json({ status: "ok", db: "ok" });
  } catch {
    return Response.json({ status: "error", db: "unreachable" }, { status: 503 });
  }
}
