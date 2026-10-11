"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Blocker } from "@/lib/delete-flow";
import { fieldErrors } from "@/lib/form-errors";
import { LearnerInput } from "@/lib/learner-input";
import { LEARNER_MESSAGES } from "@/lib/learners";
import { err, ok, type Result } from "@/lib/result";
import { Timezone } from "@/lib/timezones";
import { requireAdmin } from "@/server/auth/require";
import { authentik } from "@/server/authentik/client";
import {
  deactivateLearner,
  reactivateLearner,
} from "@/server/authentik/learners";
import { db } from "@/server/db";
import { setAdminTimezone } from "@/server/users/admin-timezone";
import {
  cancelBookingByAdmin,
  createLearner,
  deactivationPreview,
  isConsoleLearner,
  resendSetPasswordByAdmin,
  updateLearner,
  type CreateLearnerError,
  type UpdateLearnerError,
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

const isId = (id: unknown): id is string => z.uuid().safeParse(id).success;

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

const duplicate = (id: string | null): AdminFormState => ({
  kind: "error",
  fields: { email: LEARNER_MESSAGES.duplicate },
  ...(id === null
    ? {}
    : { link: { href: `/admin/users/${id}`, label: "View user" } }),
});

const addError = (e: CreateLearnerError): AdminFormState => {
  if (typeof e === "object") return duplicate(e.id);
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

const editError = (e: UpdateLearnerError): AdminFormState => {
  if (typeof e === "object") return duplicate(e.id);
  switch (e) {
    case "authentik_conflict":
      return onEmail(LEARNER_MESSAGES.authentikConflict);
    case "email_locked":
      return onEmail(LEARNER_MESSAGES.emailLocked);
    case "not_found":
      return formMessage(LEARNER_MESSAGES.gone);
    case "refused":
      return formMessage(LEARNER_MESSAGES.refused);
    case "unavailable":
      return formMessage(LEARNER_MESSAGES.unavailable);
    default: {
      const never: never = e;
      return never;
    }
  }
};

// AC-6: the lock first edit. The page binds the row's id.
export async function updateLearnerAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseLearner(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };
  if (!isId(id)) return formMessage(LEARNER_MESSAGES.gone);

  const updated = await updateLearner(
    authentik(),
    db(),
    id,
    parsed.data,
    user.id,
  );
  revalidateUsers();
  if (!updated.ok) return editError(updated.error);
  return { kind: "saved", message: `Updated ${parsed.data.name}.` };
}

// AC-7. The page binds the row's id; the value is the toast text.
export async function resendSetPasswordAdminAction(
  id: string,
): Promise<Result<string, "not_eligible">> {
  const { user } = await requireAdmin();
  if (!isId(id)) return err("not_eligible");
  const sent = await resendSetPasswordByAdmin(db(), id, user.id);
  revalidateUsers();
  if (!sent.ok) return sent;
  return ok(`Set password email queued for ${sent.value.email}.`);
}

// AC-8, the check before the confirm: the bookings a deactivation cancels,
// labelled in the admin's zone.
export async function checkDeactivate(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  const { user } = await requireAdmin();
  if (!isId(id)) return ok([]);
  return ok(await deactivationPreview(db(), id, user.timezone));
}

export type DeactivateError =
  "booking_pending" | "refused" | "unavailable" | "not_found";

// AC-8: deactivate, cancelling Upcoming and Current bookings.
export async function deactivateLearnerAction(
  id: string,
): Promise<Result<{ readonly cancelled: number }, DeactivateError>> {
  const { user } = await requireAdmin();
  if (!isId(id)) return err("not_found");
  const done = await deactivateLearner(authentik(), db(), id, user.id);
  revalidateUsers();
  if (done.ok) return done;
  switch (done.error) {
    case "booking_pending":
    case "unavailable":
    case "not_found":
      return err(done.error);
    case "is_admin":
    case "not_learner":
      return err("refused");
    default: {
      const never: never = done.error;
      return never;
    }
  }
}

export type ReactivateError =
  "authentik_missing" | "refused" | "unavailable" | "not_found";

// AC-9: reactivate, no confirm. Cancelled bookings stay cancelled.
export async function reactivateLearnerAction(
  id: string,
): Promise<Result<void, ReactivateError>> {
  const { user } = await requireAdmin();
  if (!isId(id)) return err("not_found");
  const conn = db();
  const done = await reactivateLearner(authentik(), conn, id, user.id);
  revalidateUsers();
  if (done.ok) return done;
  switch (done.error) {
    case "unavailable":
      return err("unavailable");
    case "is_admin":
    case "not_learner":
      return err("refused");
    case "not_found":
      // The app row exists, so it is the Authentik account that is gone.
      return err(
        (await isConsoleLearner(conn, id)) ? "authentik_missing" : "not_found",
      );
    default: {
      const never: never = done.error;
      return never;
    }
  }
}

// AC-10: the page binds the booking's id and the version it showed.
export async function cancelBookingAdminAction(
  id: string,
  version: number,
): Promise<Result<void, "stale">> {
  const { user } = await requireAdmin();
  const parsed = z.number().int().safeParse(version);
  const cancelled: Result<void, "stale"> =
    isId(id) && parsed.success
      ? await cancelBookingByAdmin(db(), id, parsed.data, user.id)
      : err("stale");
  revalidateUsers();
  return cancelled;
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
