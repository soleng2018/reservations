import "server-only";
import type { Kysely } from "kysely";
import type { AuditAction } from "@/lib/audit-actions";
import type { AuditTargetType } from "@/lib/db-enums";
import type { DB } from "@/server/db/types";

export type AuditEntry = {
  readonly actorUserId: string | null; // null for the system
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly summary: string;
  // Changed fields only; never secrets, ciphertext, or PII beyond ids.
  readonly metadata?: Readonly<Record<string, unknown>>;
};

// Append one audit event, inside the caller's transaction when given one.
export async function audit(db: Kysely<DB>, e: AuditEntry): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      actor_user_id: e.actorUserId,
      action: e.action,
      target_type: e.targetType,
      target_id: e.targetId,
      summary: e.summary,
      metadata: JSON.stringify(e.metadata ?? {}),
    })
    .execute();
}
