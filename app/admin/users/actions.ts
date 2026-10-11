"use server";

import { revalidatePath } from "next/cache";
import { Timezone } from "@/lib/timezones";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { setAdminTimezone } from "@/server/users/admin-timezone";

// Feature 10 (spec 0008). Every action calls requireAdmin() first (AC-14).

// AC-3. A bad zone or a row already set changes nothing; the client shows
// no error either way, and the next load tries again.
export async function setAdminTimezoneAction(zone: unknown): Promise<void> {
  const { user } = await requireAdmin();
  const parsed = Timezone.safeParse(zone);
  if (!parsed.success) return;
  const changed = await setAdminTimezone(db(), user.id, parsed.data);
  if (changed) revalidatePath("/admin", "layout");
}
