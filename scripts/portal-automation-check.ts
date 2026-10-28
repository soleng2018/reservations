// One off check of the portal automation account (spec 0023 AC-44).
//
//   npm run portal:automation-check -- --domain nileworkshop-4.com [--apply]
//
// Without --apply it only reads (the testbed, the group, the Authentik user)
// and prints what it would do. With --apply it uses the same modules as the
// reset engine: it makes the account right (AC-42), signs in to the portal
// through the real browser sign in, reads the tenant (AC-16), and makes one
// harmless GET on a list only an administrator can read. It prints only pass
// or fail per check and the user's group names: never the password, a header,
// or a reply. It creates no other object. The password exists only inside
// the process, in a `Secret`.
import { parseArgs } from "node:util";
import { portalOrigin } from "@/lib/portal-reset/portal-host";
import { guards } from "@/lib/portal-reset/guards";
import { authentik, call } from "@/server/authentik/client";
import { automationUsername } from "@/server/authentik/guard";
import { findTestbedGroup } from "@/server/authentik/groups";
import { ensureAutomationCredential } from "@/server/authentik/portal-automation";
import { db } from "@/server/db";
import { makePortalClient } from "@/server/portal-engine/client";
import { checkTenant } from "@/server/portal-engine/connect";
import { signIn } from "@/server/portal-engine/sign-in";

const { values: args } = parseArgs({
  options: {
    domain: { type: "string" },
    // For a workshop that is not a testbed in the app yet: the same two
    // values a testbed row holds. A live testbed row wins when there is one.
    group: { type: "string" },
    "portal-url": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const say = (line: string) => console.log(line);
const verdict = (name: string, pass: boolean) =>
  say(`  ${pass ? "pass" : "FAIL"}  ${name}`);

async function main(): Promise<number> {
  const domain = args.domain;
  if (!domain) {
    say(
      "usage: npm run portal:automation-check -- --domain <domain> [--apply]",
    );
    return 2;
  }
  const conn = db();
  const api = authentik();
  say(
    `portal automation check for ${domain} (${args.apply ? "apply" : "dry run"})`,
  );

  const row = await conn
    .selectFrom("testbeds")
    .select(["group_name", "portal_url"])
    .where("domain", "=", domain)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const testbed =
    row ??
    (args.group && args["portal-url"]
      ? { group_name: args.group, portal_url: args["portal-url"] }
      : undefined);
  say(
    `  info  values from ${row ? "the testbed row" : "the --group and --portal-url flags"}`,
  );
  verdict(
    "a testbed or the flags give the group and portal address",
    testbed !== undefined,
  );
  if (!testbed) return 1;
  const origin = portalOrigin(testbed.portal_url);
  verdict("its portal address is on the allowed hosts", origin !== null);
  const group = await findTestbedGroup(api, testbed.group_name);
  verdict(
    "its access group exists, is marked, and carries this domain",
    group.ok && group.value.domain === domain,
  );
  const user = await call("users.list automation", () =>
    api.coreUsersList({ username: automationUsername(domain), pageSize: 5 }),
  );
  const exists =
    user.ok &&
    user.value.results.some((u) => u.username === automationUsername(domain));
  say(
    `  info  ${automationUsername(domain)} ${exists ? "exists" : "does not exist yet"}`,
  );

  if (!args.apply) {
    say("dry run: nothing was written. Add --apply to run the checks.");
    return origin !== null && group.ok ? 0 : 1;
  }
  if (origin === null || !group.ok) return 1;

  const credential = await ensureAutomationCredential(api, {
    domain,
    groupName: testbed.group_name,
  });
  verdict(
    `credential made${credential.ok && credential.value.created ? " (user created)" : ""}`,
    credential.ok,
  );
  if (!credential.ok) {
    say(`  info  result: ${credential.error}`);
    return 1;
  }
  const names = await call("users.retrieve", () =>
    api.coreUsersList({
      username: automationUsername(domain),
      pageSize: 5,
    }),
  );
  const groupIds = names.ok
    ? (names.value.results.find(
        (u) => u.username === automationUsername(domain),
      )?.groups ?? [])
    : [];
  const groupNames = await Promise.all(
    groupIds.map((id) =>
      call("groups.retrieve", () =>
        api.coreGroupsRetrieve({ groupUuid: id, includeUsers: false }),
      ).then((g) => (g.ok ? g.value.name : "unknown")),
    ),
  );
  say(`  info  groups: ${groupNames.join(", ") || "none"}`);

  const signed = await signIn({
    origin,
    username: credential.value.username,
    password: credential.value.password,
  });
  verdict("portal sign in", signed.ok);
  if (!signed.ok) {
    say(`  info  reason: ${signed.error}`);
    return 1;
  }
  const client = makePortalClient(signed.value.session);
  try {
    const tenant = await checkTenant(client, domain);
    verdict("signed in tenant matches the domain", tenant.ok);
    const list = guards[0]?.listPath;
    const read =
      list === undefined
        ? undefined
        : await client.call({ method: "GET", path: list });
    verdict(
      "an administrator only list can be read",
      read?.ok === true && read.value.status === 200,
    );
    return tenant.ok && read?.ok === true && read.value.status === 200 ? 0 : 1;
  } finally {
    await client.close();
  }
}

main().then(
  async (code) => {
    await db().destroy();
    process.exit(code);
  },
  async (e: unknown) => {
    console.error(
      "portal automation check crashed:",
      e instanceof Error ? e.message : "error",
    );
    await db().destroy();
    process.exit(1);
  },
);
