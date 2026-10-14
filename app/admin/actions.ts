"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { API_KEY_MESSAGES, typeInUseMessage } from "@/lib/api-keys";
import {
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  TestbedInput,
  TestbedTypeInput,
} from "@/lib/catalog-input";
import type { Blocker, DeleteRemoveError } from "@/lib/delete-flow";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import { ok, err, type Result } from "@/lib/result";
import { TESTBED_MESSAGES, type TestbedEditDefaults } from "@/lib/testbeds";
import { requireAdmin } from "@/server/auth/require";
import { authentik } from "@/server/authentik/client";
import {
  createApiKey,
  deleteApiKey,
  updateApiKey,
  type ApiKeyCreateError,
} from "@/server/catalog/api-keys";
import {
  createTestbed,
  deleteTestbed,
  getTestbedForEdit,
  updateTestbed,
} from "@/server/catalog/testbeds";
import {
  createTestbedType,
  deleteTestbedType,
  updateTestbedType,
} from "@/server/catalog/testbed-types";
import { db } from "@/server/db";
import {
  apiKeyBlockers,
  testbedBlockers,
  testbedTypeBlockers,
} from "@/server/db/delete-blockers";
import { assertEncryptionEnv } from "@/server/env";

export type AdminFormState =
  | { readonly kind: "idle" }
  | { readonly kind: "saved"; readonly message: string }
  | {
      readonly kind: "error";
      readonly message?: string;
      readonly fields: FieldErrors;
      // Shown under the field errors (spec 0008 AC-5: "View user").
      readonly link?: { readonly href: string; readonly label: string };
    };

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
};

const texts = (form: FormData, key: string) =>
  form.getAll(key).map((v) => (typeof v === "string" ? v : ""));

const isId = (id: unknown): id is string => z.uuid().safeParse(id).success;

const parseTestbedType = (form: FormData) =>
  TestbedTypeInput.safeParse({
    name: text(form, "name"),
    durationValue: text(form, "durationValue"),
    durationUnit: text(form, "durationUnit"),
  });

const DUPLICATE_TYPE: AdminFormState = {
  kind: "error",
  fields: { name: "A testbed type with this name already exists." },
};
const TYPE_GONE = "This testbed type no longer exists.";

// AC-1. The list on /admin/testbed-types shows the result.
export async function createTestbedTypeAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbedType(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createTestbedType(db(), parsed.data, user.id);
  if (!created.ok) return DUPLICATE_TYPE;
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${parsed.data.name}.` };
}

// Feature 7. The page binds the row's id.
export async function updateTestbedTypeAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbedType(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };
  if (!isId(id)) return { kind: "error", message: TYPE_GONE, fields: {} };

  const updated = await updateTestbedType(db(), id, parsed.data, user.id);
  if (!updated.ok) {
    switch (updated.error) {
      case "duplicate_name":
        return DUPLICATE_TYPE;
      case "not_found":
        revalidatePath("/admin", "layout");
        return { kind: "error", message: TYPE_GONE, fields: {} };
      default: {
        const never: never = updated.error;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Updated ${parsed.data.name}.` };
}

// Feature 7, the delete flow's check: the live testbeds using this type.
export async function checkTestbedTypeDelete(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  await requireAdmin();
  if (!isId(id)) return ok([]);
  return ok(await testbedTypeBlockers(db(), id));
}

// Feature 7, the delete flow's remove (spec 0002 AC-4, AC-14).
export async function deleteTestbedTypeAction(
  id: string,
): Promise<Result<void, DeleteRemoveError>> {
  const { user } = await requireAdmin();
  if (!isId(id)) return err({ kind: "failed", message: TYPE_GONE });

  const deleted = await deleteTestbedType(db(), id, user.id);
  revalidatePath("/admin", "layout");
  if (deleted.ok) return ok(undefined);
  switch (deleted.error.kind) {
    case "blocked":
      return err(deleted.error);
    case "not_found":
      return err({ kind: "failed", message: TYPE_GONE });
    default: {
      const never: never = deleted.error;
      return never;
    }
  }
}

// Feature 8 (spec 0006). The secret is read from the form, encrypted, and
// never sent back: errors carry fixed messages, and the dialog keeps what
// was typed on the client.
const apiKeyFields = (form: FormData) => ({
  name: text(form, "name"),
  type: text(form, "type"),
  baseUrl: text(form, "baseUrl"),
  secret: text(form, "secret") ?? "",
});

const NOT_CONFIGURED: AdminFormState = {
  kind: "error",
  message: API_KEY_MESSAGES.notConfigured,
  fields: {},
};
// The save errors create and update share (spec 0006 AC-3, AC-12).
const apiKeyError = (e: ApiKeyCreateError): AdminFormState => {
  switch (e) {
    case "duplicate_name":
      return {
        kind: "error",
        fields: { name: API_KEY_MESSAGES.duplicateName },
      };
    case "cloudflare_exists":
      return {
        kind: "error",
        fields: { type: API_KEY_MESSAGES.cloudflareExists },
      };
    case "cloudflare_invalid":
      return {
        kind: "error",
        fields: { secret: API_KEY_MESSAGES.cloudflareInvalid },
      };
    case "cloudflare_unavailable":
      return {
        kind: "error",
        message: API_KEY_MESSAGES.cloudflareUnavailable,
        fields: {},
      };
    default: {
      const never: never = e;
      return never;
    }
  }
};

// AC-2, AC-3, AC-9, AC-12.
export async function createApiKeyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const encryption = assertEncryptionEnv();
  if (!encryption.ok) return NOT_CONFIGURED;
  const parsed = ApiKeyCreateInput.safeParse(apiKeyFields(form));
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createApiKey(
    db(),
    encryption.value.keyring,
    parsed.data,
    user.id,
  );
  if (!created.ok) return apiKeyError(created.error);
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${parsed.data.name}.` };
}

// AC-4, AC-5, AC-9, AC-12. The page binds the row's id; a blank key keeps
// the stored one.
export async function updateApiKeyAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const encryption = assertEncryptionEnv();
  if (!encryption.ok) return NOT_CONFIGURED;
  const parsed = ApiKeyUpdateInput.safeParse(apiKeyFields(form));
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };
  if (!isId(id))
    return { kind: "error", message: API_KEY_MESSAGES.gone, fields: {} };

  const updated = await updateApiKey(
    db(),
    encryption.value.keyring,
    id,
    parsed.data,
    user.id,
  );
  if (!updated.ok) {
    const e = updated.error;
    if (typeof e === "object") {
      switch (e.kind) {
        case "type_in_use":
          return { kind: "error", fields: { type: typeInUseMessage(e.names) } };
        default: {
          const never: never = e.kind;
          return never;
        }
      }
    }
    switch (e) {
      case "duplicate_name":
      case "cloudflare_exists":
      case "cloudflare_invalid":
      case "cloudflare_unavailable":
        return apiKeyError(e);
      case "cloudflare_retype":
        return {
          kind: "error",
          fields: { secret: API_KEY_MESSAGES.cloudflareRetype },
        };
      case "not_found":
        revalidatePath("/admin", "layout");
        return { kind: "error", message: API_KEY_MESSAGES.gone, fields: {} };
      default: {
        const never: never = e;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Updated ${parsed.data.name}.` };
}

// AC-6, the delete flow's check: the live testbeds using this key as their
// IDP.
export async function checkApiKeyDelete(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  await requireAdmin();
  if (!isId(id)) return ok([]);
  return ok(await apiKeyBlockers(db(), id));
}

// AC-6, the delete flow's remove (spec 0002 AC-14).
export async function deleteApiKeyAction(
  id: string,
): Promise<Result<void, DeleteRemoveError>> {
  const { user } = await requireAdmin();
  const gone = { kind: "failed", message: API_KEY_MESSAGES.gone } as const;
  if (!isId(id)) return err(gone);

  const deleted = await deleteApiKey(db(), id, user.id);
  revalidatePath("/admin", "layout");
  if (deleted.ok) return ok(undefined);
  switch (deleted.error.kind) {
    case "blocked":
      return err(deleted.error);
    case "not_found":
      return err(gone);
    default: {
      const never: never = deleted.error;
      return never;
    }
  }
}

// Feature 9 (spec 0007). Clients arrive as parallel lists in form order; an
// OS login is never echoed back (errors carry fixed messages, and the dialog
// keeps what was typed on the client).
const parseTestbed = (form: FormData) => {
  const kinds = texts(form, "clientKind");
  const names = texts(form, "clientName");
  const urls = texts(form, "clientUrl");
  const osUsernames = texts(form, "clientOsUsername");
  const osPasswords = texts(form, "clientOsPassword");
  return TestbedInput.safeParse({
    name: text(form, "name"),
    testbedTypeId: text(form, "testbedTypeId"),
    idpApiKeyId: text(form, "idpApiKeyId"),
    portalUrl: text(form, "portalUrl"),
    lmsUrl: text(form, "lmsUrl"),
    clients: kinds.map((kind, i) => ({
      kind,
      name: names[i],
      url: urls[i],
      osUsername: osUsernames[i],
      osPassword: osPasswords[i],
    })),
  });
};

const testbedError = {
  duplicateName: {
    kind: "error",
    fields: { name: TESTBED_MESSAGES.duplicateName },
  },
  typeGone: {
    kind: "error",
    fields: { testbedTypeId: TESTBED_MESSAGES.typeGone },
  },
  idpGone: {
    kind: "error",
    fields: { idpApiKeyId: TESTBED_MESSAGES.idpGone },
  },
  gone: { kind: "error", message: TESTBED_MESSAGES.gone, fields: {} },
} as const satisfies Record<string, AdminFormState>;

// Spec 0004 AC-2, spec 0007 AC-2.
export async function createTestbedAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbed(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createTestbed(authentik(), db(), parsed.data, user.id);
  if (!created.ok) {
    switch (created.error) {
      case "duplicate_name":
        return testbedError.duplicateName;
      case "type_not_found":
        return testbedError.typeGone;
      case "idp_not_found":
        return testbedError.idpGone;
      case "group_failed":
        return {
          kind: "error",
          message: TESTBED_MESSAGES.groupFailed,
          fields: {},
        };
      default: {
        const never: never = created.error;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${parsed.data.name}.` };
}

// AC-3, the edit dialog's load on open: the one payload with OS logins.
export async function loadTestbedForEdit(
  id: string,
): Promise<Result<TestbedEditDefaults, "not_found">> {
  await requireAdmin();
  if (!isId(id)) return err("not_found");
  return getTestbedForEdit(db(), id);
}

// AC-3, AC-4, AC-5. The page binds the row's id.
export async function updateTestbedAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbed(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };
  if (!isId(id)) return testbedError.gone;

  const updated = await updateTestbed(db(), id, parsed.data, user.id);
  if (!updated.ok) {
    switch (updated.error) {
      case "duplicate_name":
        return testbedError.duplicateName;
      case "type_not_found":
        return testbedError.typeGone;
      case "idp_not_found":
        return testbedError.idpGone;
      case "not_ready":
        return {
          kind: "error",
          message: TESTBED_MESSAGES.notReady,
          fields: {},
        };
      case "not_found":
        revalidatePath("/admin", "layout");
        return testbedError.gone;
      default: {
        const never: never = updated.error;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Updated ${parsed.data.name}.` };
}

// AC-6, the delete flow's check: the testbed's Upcoming, Current, and
// Pending reservations, phased by the DB clock in the same transaction.
export async function checkTestbedDelete(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  await requireAdmin();
  if (!isId(id)) return ok([]);
  const blockers = await db()
    .transaction()
    .execute((trx) => testbedBlockers(trx, id));
  revalidatePath("/admin", "layout");
  return ok(blockers);
}

// AC-6, the delete flow's remove (spec 0002 AC-14).
export async function deleteTestbedAction(
  id: string,
): Promise<Result<void, DeleteRemoveError>> {
  const { user } = await requireAdmin();
  const gone = { kind: "failed", message: TESTBED_MESSAGES.gone } as const;
  if (!isId(id)) return err(gone);

  const deleted = await deleteTestbed(db(), id, user.id);
  revalidatePath("/admin", "layout");
  if (deleted.ok) return ok(undefined);
  switch (deleted.error.kind) {
    case "blocked":
      return err(deleted.error);
    case "not_found":
      return err(gone);
    default: {
      const never: never = deleted.error;
      return never;
    }
  }
}
