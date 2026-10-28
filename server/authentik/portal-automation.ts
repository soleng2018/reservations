import "server-only";
import { randomInt } from "node:crypto";
import { UserTypeEnum } from "@goauthentik/api/dist/esm/index.js";
import { err, ok, type Result } from "@/lib/result";
import { secret, type Secret } from "@/server/portal-engine/secret";
import { call, type CoreApi, type User } from "./client";
import {
  AUTOMATION_MARKER,
  automationUsername,
  guardAutomationWrite,
} from "./guard";
import { findTestbedGroup } from "./groups";

// Spec 0023 AC-42: the automation account the reset engine signs in as.
// `ensureAutomationCredential` runs before every sign in. It makes the user
// if it is missing, keeps it in the testbed's access group (the group the
// portal maps to Administrator), and sets a new random password that exists
// only in the returned `Secret`: not in a file, a row, a job, a log, or an
// email. Every write goes through `guardAutomationWrite`.

export const AUTOMATION_PATH = "hol/automation";
export const PASSWORD_LENGTH = 40;

// `result` of the `portal_reset.credential_failed` audit row.
export type CredentialFailure =
  | "refused" // the guard said no, or the group fails its checks
  | "group_missing"
  | "not_found" // the user vanished between a read and a write
  | "failed"; // Authentik was unreachable or refused

export type AutomationTestbed = {
  readonly domain: string;
  readonly groupName: string;
};

export type Credential = {
  readonly username: string;
  readonly password: Secret<string>;
  // This call made the Authentik user (the audit row `automation_user_created`).
  readonly created: boolean;
};

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!#$%*+-=?@^_";
const ALL = `${LETTERS}${DIGITS}${SYMBOLS}`;

const pick = (chars: string, below: (n: number) => number): string =>
  chars.charAt(below(chars.length));

// 40 characters from the system random source, with at least one of each
// class so Authentik's policy accepts it. `below` is injectable for tests
// only; the default is `crypto.randomInt`.
export function generatePassword(
  below: (n: number) => number = (n) => randomInt(n),
): string {
  const required = [LETTERS, LETTERS, DIGITS, DIGITS, SYMBOLS].map((set) =>
    pick(set, below),
  );
  const rest = Array.from({ length: PASSWORD_LENGTH - required.length }, () =>
    pick(ALL, below),
  );
  // Fisher-Yates over the whole password, so the required ones move too.
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = below(i + 1);
    [chars[i], chars[j]] = [chars[j] ?? "", chars[i] ?? ""];
  }
  return chars.join("");
}

const toFailure = (e: string): CredentialFailure =>
  e === "not_testbed_group" || e === "is_admin" || e === "not_automation"
    ? "refused"
    : e === "not_found"
      ? "not_found"
      : "failed";

async function findOrCreate(
  api: CoreApi,
  testbed: AutomationTestbed,
): Promise<Result<{ user: User; created: boolean }, CredentialFailure>> {
  const username = automationUsername(testbed.domain);
  const found = await call("users.list automation", () =>
    api.coreUsersList({ username, pageSize: 5 }),
  );
  if (!found.ok) return err("failed");
  const existing = found.value.results.find((u) => u.username === username);
  if (existing) return ok({ user: existing, created: false });
  const allowed = await guardAutomationWrite(api, {
    kind: "create",
    domain: testbed.domain,
  });
  if (!allowed.ok) return err(toFailure(allowed.error));
  const created = await call("users.create automation", () =>
    api.coreUsersCreate({
      userRequest: {
        username,
        name: "Nile Portal Automation",
        isActive: true,
        path: AUTOMATION_PATH,
        type: UserTypeEnum.Internal,
        // The SAML NameID and the portal's domain routing read `mail`.
        attributes: {
          mail: username,
          firstName: "Automation",
          lastName: "Portal",
          mobile: "",
          [AUTOMATION_MARKER]: true,
        },
      },
    }),
  );
  return created.ok
    ? ok({ user: created.value, created: true })
    : err("failed");
}

export async function ensureAutomationCredential(
  api: CoreApi,
  testbed: AutomationTestbed,
  newPassword: () => string = generatePassword,
): Promise<Result<Credential, CredentialFailure>> {
  // The group first, read fresh: with no usable group nothing is written.
  const group = await findTestbedGroup(api, testbed.groupName);
  if (!group.ok)
    return err(
      group.error === "not_found"
        ? "group_missing"
        : group.error === "unavailable"
          ? "failed"
          : "refused",
    );
  if (group.value.domain !== testbed.domain) return err("refused");

  const user = await findOrCreate(api, testbed);
  if (!user.ok) return user;
  const { pk } = user.value.user;

  if (!(user.value.user.groups ?? []).includes(group.value.pk)) {
    const allowed = await guardAutomationWrite(api, {
      kind: "add_to_group",
      domain: testbed.domain,
      pk,
      groupUuid: group.value.pk,
    });
    if (!allowed.ok) return err(toFailure(allowed.error));
    const added = await call("groups.add_user automation", () =>
      api.coreGroupsAddUserCreate({
        groupUuid: group.value.pk,
        userAccountRequest: { pk },
      }),
    );
    if (!added.ok) return err(toFailure(added.error));
  }

  const allowed = await guardAutomationWrite(api, {
    kind: "set_password",
    domain: testbed.domain,
    pk,
  });
  if (!allowed.ok) return err(toFailure(allowed.error));
  const password = newPassword();
  const set = await call("users.set_password automation", () =>
    api.coreUsersSetPasswordCreate({
      id: pk,
      userPasswordSetRequest: { password },
    }),
  );
  if (!set.ok) return err(toFailure(set.error));
  return ok({
    username: automationUsername(testbed.domain),
    password: secret(password),
    created: user.value.created,
  });
}
