import "server-only";
import { z } from "zod";
import { authentikEnv } from "@/server/env";

// Spec 0023 AC-39, AC-44: the permissions the automation account needs.
export const AUTOMATION_PERMISSIONS: readonly string[] = [
  "authentik_core.add_user",
  "authentik_core.add_user_to_group",
  "authentik_core.change_user",
  "authentik_core.reset_user_password",
];

const meSchema = z.object({
  user: z.object({ roles: z.array(z.object({ pk: z.string() })) }),
});
const permissionsSchema = z.object({
  results: z.array(z.object({ app_label: z.string(), codename: z.string() })),
});

// Pure: the required permissions the role does not hold.
export const missingPermissions = (
  held: readonly string[],
  required: readonly string[] = AUTOMATION_PERMISSIONS,
): readonly string[] => required.filter((p) => !held.includes(p));

// The start check's one line: undefined when all is well.
export const permissionLine = (
  missing: readonly string[],
): string | undefined =>
  missing.length === 0
    ? undefined
    : `portal reset: the provisioning role lacks ${missing.join(", ")}, so a reset cannot create the automation account`;

// Reads the provisioning role's own permissions. Never throws: a failed read
// is reported as a line too, because the worker must start either way.
export async function checkAutomationPermissions(
  fetchApi: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const env = authentikEnv();
    const get = async (path: string): Promise<unknown> => {
      const res = await fetchApi(`${env.AUTHENTIK_URL}/api/v3/${path}`, {
        headers: {
          Authorization: `Bearer ${env.AUTHENTIK_PROVISIONING_TOKEN}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    };
    const me = meSchema.parse(await get("core/users/me/"));
    const held = (
      await Promise.all(
        me.user.roles.map(async (r) =>
          permissionsSchema
            .parse(await get(`rbac/permissions/?role=${r.pk}&page_size=500`))
            .results.map((p) => `${p.app_label}.${p.codename}`),
        ),
      )
    ).flat();
    return permissionLine(missingPermissions(held));
  } catch (e) {
    return `portal reset: could not read the provisioning role's permissions (${e instanceof Error ? e.message : "unknown error"})`;
  }
}
