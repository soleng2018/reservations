"use server";

import { revalidatePath } from "next/cache";
import { TestbedInput, TestbedTypeInput } from "@/lib/catalog-input";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import { requireAdmin } from "@/server/auth/require";
import { authentik } from "@/server/authentik/client";
import { createTestbed } from "@/server/catalog/testbeds";
import { createTestbedType } from "@/server/catalog/testbed-types";
import { db } from "@/server/db";

export type AdminFormState =
  | { readonly kind: "idle" }
  | { readonly kind: "saved"; readonly message: string }
  | {
      readonly kind: "error";
      readonly message?: string;
      readonly fields: FieldErrors;
    };

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
};

const texts = (form: FormData, key: string) =>
  form.getAll(key).map((v) => (typeof v === "string" ? v : ""));

// AC-1. Create only; the list on /admin/testbed-types shows the result.
export async function createTestbedTypeAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = TestbedTypeInput.safeParse({
    name: text(form, "name"),
    durationValue: text(form, "durationValue"),
    durationUnit: text(form, "durationUnit"),
  });
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createTestbedType(db(), parsed.data, user.id);
  if (!created.ok)
    return {
      kind: "error",
      fields: { name: "A testbed type with this name already exists." },
    };
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${parsed.data.name}.` };
}

// AC-2. Clients arrive as parallel lists in form order.
export async function createTestbedAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const kinds = texts(form, "clientKind");
  const names = texts(form, "clientName");
  const urls = texts(form, "clientUrl");
  const parsed = TestbedInput.safeParse({
    name: text(form, "name"),
    testbedTypeId: text(form, "testbedTypeId"),
    portalUrl: text(form, "portalUrl"),
    lmsUrl: text(form, "lmsUrl"),
    clients: kinds.map((kind, i) => ({ kind, name: names[i], url: urls[i] })),
  });
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createTestbed(authentik(), db(), parsed.data, user.id);
  if (!created.ok) {
    switch (created.error) {
      case "duplicate_name":
        return {
          kind: "error",
          fields: { name: "A testbed with this name already exists." },
        };
      case "type_not_found":
        return {
          kind: "error",
          fields: { testbedTypeId: "That type no longer exists." },
        };
      case "group_failed":
        return {
          kind: "error",
          message: "Couldn't create the testbed's access group, try again",
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
