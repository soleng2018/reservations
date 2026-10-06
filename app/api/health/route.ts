import { sql } from "kysely";
import { connection } from "next/server";
import { db } from "@/server/db";

export async function GET(): Promise<Response> {
  await connection();
  try {
    await sql`select 1`.execute(db());
    return Response.json({ status: "ok", db: "ok" });
  } catch (err) {
    // Covers env misconfiguration (Zod) as well as an unreachable database.
    console.error("health: database check failed", err);
    return Response.json(
      { status: "error", db: "unreachable" },
      { status: 503 },
    );
  }
}
