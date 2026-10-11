"use server";

import { revalidatePath } from "next/cache";
import { fieldErrors } from "@/lib/form-errors";
import { LearnerInput } from "@/lib/learner-input";
import { LEARNER_MESSAGES } from "@/lib/learners";
import { Timezone } from "@/lib/timezones";
import { requireAdmin } from "@/server/auth/require";
import { authentik } from "@/server/authentik/client";
import { db } from "@/server/db";
import { setAdminTimezone } from "@/server/users/admin-timezone";
import {
  createLearner,
  type CreateLearnerError,
} from "@/server/users/learners";
import type { AdminFormState } from "../actions";

// Feature 10 (spec 0008). Every action calls requireAdmin() first (AC-14)
// and refreshes the users list and every detail page after a change.

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
};

const parseLearner = (form: FormData) =>
  LearnerInput.safeParse({
    name: text(form, "name"),
    company: text(form, "company"),
    email: text(form, "email"),
    timezone: text(form, "timezone"),
  });

const revalidateUsers = () => revalidatePath("/admin/users", "layout");

const onEmail = (message: string): AdminFormState => ({
  kind: "error",
  fields: { email: message },
});
const formMessage = (message: string): AdminFormState => ({
  kind: "error",
  message,
  fields: {},
});

const addError = (e: CreateLearnerError): AdminFormState => {
  if (typeof e === "object")
    return {
      kind: "error",
      fields: { email: LEARNER_MESSAGES.duplicate },
      link: { href: `/admin/users/${e.id}`, label: "View user" },
    };
  switch (e) {
    case "setting_up":
      return onEmail(LEARNER_MESSAGES.settingUp);
    case "admin_email":
      return onEmail(LEARNER_MESSAGES.adminEmail);
    case "authentik_conflict":
      return onEmail(LEARNER_MESSAGES.authentikConflict);
    case "authentik_disabled":
      return onEmail(LEARNER_MESSAGES.authentikDisabled);
    case "unavailable":
      return formMessage(LEARNER_MESSAGES.unavailable);
    default: {
      const never: never = e;
      return never;
    }
  }
};

// AC-4, AC-5: the add saga.
export async function createLearnerAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseLearner(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createLearner(authentik(), db(), parsed.data, user.id);
  if (!created.ok) return addError(created.error);
  revalidateUsers();
  return { kind: "saved", message: `Added ${parsed.data.name}.` };
}

// AC-3. A bad zone or a row already set changes nothing; the client shows
// no error either way, and the next load tries again.
export async function setAdminTimezoneAction(zone: unknown): Promise<void> {
  const { user } = await requireAdmin();
  const parsed = Timezone.safeParse(zone);
  if (!parsed.success) return;
  const changed = await setAdminTimezone(db(), user.id, parsed.data);
  if (changed) revalidatePath("/admin", "layout");
}
