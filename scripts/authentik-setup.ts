// One time, idempotent Authentik setup for the app (spec 0003, AC-13).
//
//   AUTHENTIK_URL=https://authentik.example \
//   AUTHENTIK_MASTER_TOKEN_FILE=~/secrets/authentik_master_token \
//   APP_URLS=https://hol.example,http://localhost:3000 \
//   npm run authentik:setup -- [--apply] [--secret-out <path>]
//
// Without --apply it only prints what it would change. The master token is
// read here and nowhere else: web and worker never load it, so it has no
// field in server/env.ts (spec 0003 invariant) and is parsed in this script.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  ADMIN_GROUP,
  APP_NAME,
  APP_SLUG,
  LEARNER_PATH,
  PROVIDER_NAME,
  PROVISIONING_ACCOUNT,
  PROVISIONING_ROLE,
  RECOVERY_FLOW_SLUG,
  desiredProvider,
  diffFields,
  parseAppUrls,
  planPermissions,
  type FieldChange,
} from "./authentik-setup-plan";

const envSchema = z.object({
  AUTHENTIK_URL: z.url().transform((u) => new URL(u).origin),
  AUTHENTIK_MASTER_TOKEN: z.string().min(1),
  APP_URLS: z.string().min(1),
});

const readSecret = (name: string): string | undefined => {
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() : process.env[name];
};

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "secret-out": { type: "string" },
  },
});

const env = envSchema.parse({
  AUTHENTIK_URL: process.env.AUTHENTIK_URL,
  AUTHENTIK_MASTER_TOKEN: readSecret("AUTHENTIK_MASTER_TOKEN"),
  APP_URLS: process.env.APP_URLS,
});
const apply = args.apply;
const api = `${env.AUTHENTIK_URL}/api/v3`;

// ---- HTTP edge -------------------------------------------------------------

type Method = "GET" | "POST" | "PATCH";

async function call<T>(
  schema: z.ZodType<T>,
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.AUTHENTIK_MASTER_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return schema.parse(text ? JSON.parse(text) : {});
}

const page = <T extends z.ZodType>(item: T) =>
  z.object({ results: z.array(item) });

const list = async <T>(item: z.ZodType<T>, path: string): Promise<T[]> =>
  (await call(page(item), "GET", path)).results;

const one = async <T>(
  item: z.ZodType<T>,
  path: string,
  what: string,
): Promise<T | undefined> => {
  // Some endpoints ignore a filter (e.g. applications `?slug=`), so the
  // identifying query params are also matched exactly on the results.
  const exact = [...new URL(path, api).searchParams].filter(([k]) =>
    ["slug", "name", "username", "default"].includes(k),
  );
  const found = (await list(item, path)).filter((r) =>
    exact.every(([k, v]) => String((r as Record<string, unknown>)[k]) === v),
  );
  if (found.length > 1) throw new Error(`more than one ${what} matched`);
  return found[0];
};

const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing in Authentik: ${what}`);
  return v;
};

const q = encodeURIComponent;
const pkOnly = z.looseObject({ pk: z.union([z.string(), z.number()]) });

// ---- Reporting -------------------------------------------------------------

const say = (line: string) => console.log(line);
const show = (v: unknown) => JSON.stringify(v);
const reportChanges = (what: string, changes: readonly FieldChange[]) =>
  changes.length === 0
    ? say(`  ok      ${what}`)
    : changes.forEach((c) =>
        say(`  change  ${what}.${c.field}: ${show(c.from)} → ${show(c.to)}`),
      );

// Runs `write` only with --apply; returns undefined on a dry run.
const write = async <T>(
  label: string,
  run: () => Promise<T>,
): Promise<T | undefined> => {
  say(`  ${apply ? "apply " : "would "}  ${label}`);
  return apply ? run() : undefined;
};

// ---- Steps -----------------------------------------------------------------

const flowSchema = z.looseObject({
  pk: z.string(),
  slug: z.string(),
  designation: z.string(),
});

async function lookups() {
  const flow = async (slug: string) =>
    must(
      await one(flowSchema, `/flows/instances/?slug=${q(slug)}`, slug),
      `flow ${slug}`,
    ).pk;
  const mapping = z.looseObject({
    pk: z.string(),
    managed: z.string().nullable(),
  });
  const scopes = await list(
    mapping,
    "/propertymappings/provider/scope/?page_size=100",
  );
  const managed = (key: string) =>
    must(
      scopes.find(
        (m) => m.managed === `goauthentik.io/providers/oauth2/scope-${key}`,
      ),
      `scope mapping ${key}`,
    ).pk;
  const cert = must(
    await one(
      z.looseObject({ pk: z.string(), name: z.string() }),
      `/crypto/certificatekeypairs/?has_key=true&name=${q("authentik Self-signed Certificate")}`,
      "signing certificate",
    ),
    "default signing certificate",
  );
  return {
    authorizationFlow: await flow(
      "default-provider-authorization-implicit-consent",
    ),
    invalidationFlow: await flow("default-provider-invalidation-flow"),
    signingKey: cert.pk,
    scopeMappings: ["openid", "email", "profile"].map(managed),
  };
}

const providerSchema = z.looseObject({
  pk: z.number(),
  name: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
});

async function ensureProvider(appUrls: readonly string[]) {
  say("OIDC provider");
  const desired = desiredProvider({ appUrls, ...(await lookups()) });
  const current = await one(
    providerSchema,
    `/providers/oauth2/?name=${q(PROVIDER_NAME)}`,
    "provider",
  );
  if (!current)
    return write(`create provider ${PROVIDER_NAME}`, () =>
      call(providerSchema, "POST", "/providers/oauth2/", desired),
    );
  const changes = diffFields(current, desired);
  reportChanges(PROVIDER_NAME, changes);
  if (changes.length === 0) return current;
  const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]));
  return (
    (await write(`update provider ${PROVIDER_NAME}`, () =>
      call(providerSchema, "PATCH", `/providers/oauth2/${current.pk}/`, patch),
    )) ?? current
  );
}

async function ensureApplication(providerPk: number | undefined) {
  say("Application");
  const app = z.looseObject({
    slug: z.string(),
    name: z.string(),
    provider: z.number().nullable(),
  });
  const current = await one(
    app,
    `/core/applications/?slug=${q(APP_SLUG)}`,
    "application",
  );
  const desired = {
    name: APP_NAME,
    slug: APP_SLUG,
    provider: providerPk ?? null,
  };
  if (!current) {
    await write(`create application ${APP_SLUG}`, () =>
      call(app, "POST", "/core/applications/", desired),
    );
    return;
  }
  const changes = diffFields(current, desired);
  reportChanges(`application ${APP_SLUG}`, changes);
  if (changes.length > 0)
    await write(`update application ${APP_SLUG}`, () =>
      call(app, "PATCH", `/core/applications/${q(APP_SLUG)}/`, desired),
    );
}

async function ensureAdminGroup() {
  say("Admin group");
  const group = z.looseObject({ pk: z.string(), is_superuser: z.boolean() });
  const current = await one(
    group,
    `/core/groups/?name=${q(ADMIN_GROUP)}`,
    ADMIN_GROUP,
  );
  if (!current) {
    await write(`create group ${ADMIN_GROUP} (members are added by hand)`, () =>
      call(group, "POST", "/core/groups/", {
        name: ADMIN_GROUP,
        is_superuser: false,
      }),
    );
    return;
  }
  // Membership is the owner's; the script never adds or removes members.
  say(
    `  ok      group ${ADMIN_GROUP}${current.is_superuser ? " (note: grants Authentik superuser)" : ""}`,
  );
}

const promptStage = z.looseObject({
  pk: z.string(),
  name: z.string(),
  fields: z.array(z.string()),
});
const writeStage = z.looseObject({
  pk: z.string(),
  name: z.string(),
  user_creation_mode: z.string(),
});
const binding = z.looseObject({
  pk: z.string(),
  stage: z.string(),
  order: z.number(),
});

// hol-recovery: set a password, then done. Entered only through a recovery
// link (the link carries the user), so it has no identification stage.
async function ensureRecoveryFlow(): Promise<string | undefined> {
  say("Recovery flow");
  const promptName = "hol-recovery-password";
  const writeName = "hol-recovery-write";
  const fieldPk = async (name: string) =>
    must(
      await one(pkOnly, `/stages/prompt/prompts/?name=${q(name)}`, name),
      `prompt ${name}`,
    ).pk;
  const fields = [
    String(await fieldPk("default-password-change-field-password")),
    String(await fieldPk("default-password-change-field-password-repeat")),
  ];

  const flow =
    (await one(
      flowSchema,
      `/flows/instances/?slug=${q(RECOVERY_FLOW_SLUG)}`,
      "flow",
    )) ??
    (await write(`create flow ${RECOVERY_FLOW_SLUG}`, () =>
      call(flowSchema, "POST", "/flows/instances/", {
        name: "HOL set password",
        slug: RECOVERY_FLOW_SLUG,
        title: "Set your password",
        designation: "recovery",
        authentication: "none",
      }),
    ));
  if (flow && flow.designation !== "recovery")
    throw new Error(
      `flow ${RECOVERY_FLOW_SLUG} exists with designation ${flow.designation}`,
    );

  const prompt =
    (await one(
      promptStage,
      `/stages/prompt/stages/?name=${q(promptName)}`,
      promptName,
    )) ??
    (await write(`create prompt stage ${promptName}`, () =>
      call(promptStage, "POST", "/stages/prompt/stages/", {
        name: promptName,
        fields,
      }),
    ));
  if (prompt) {
    const changes = diffFields(prompt, { fields });
    reportChanges(`stage ${promptName}`, changes);
    if (changes.length > 0)
      await write(`update stage ${promptName}`, () =>
        call(promptStage, "PATCH", `/stages/prompt/stages/${prompt.pk}/`, {
          fields,
        }),
      );
  }

  const userWrite =
    (await one(
      writeStage,
      `/stages/user_write/?name=${q(writeName)}`,
      writeName,
    )) ??
    (await write(`create user write stage ${writeName}`, () =>
      call(writeStage, "POST", "/stages/user_write/", {
        name: writeName,
        user_creation_mode: "never_create",
      }),
    ));
  if (userWrite && userWrite.user_creation_mode !== "never_create")
    throw new Error(`stage ${writeName} must not create users`);

  if (flow && prompt && userWrite) {
    const bound = await list(
      binding,
      `/flows/bindings/?target=${flow.pk}&page_size=50`,
    );
    const want = [
      { stage: prompt.pk, order: 10 },
      { stage: userWrite.pk, order: 20 },
    ];
    const extra = bound.filter((b) => !want.some((w) => w.stage === b.stage));
    if (extra.length > 0)
      throw new Error(
        `flow ${RECOVERY_FLOW_SLUG} has unexpected stage bindings; fix by hand`,
      );
    for (const w of want) {
      const have = bound.find((b) => b.stage === w.stage);
      if (!have)
        await write(
          `bind stage order ${w.order} to ${RECOVERY_FLOW_SLUG}`,
          () =>
            call(binding, "POST", "/flows/bindings/", {
              target: flow.pk,
              ...w,
            }),
        );
      else if (have.order !== w.order)
        await write(`reorder stage binding to ${w.order}`, () =>
          call(binding, "PATCH", `/flows/bindings/${have.pk}/`, {
            order: w.order,
          }),
        );
      else say(`  ok      binding order ${w.order}`);
    }
  } else if (!apply)
    say(`  would   bind the two stages to ${RECOVERY_FLOW_SLUG}`);
  return flow?.pk;
}

async function ensureBrandRecovery(flowPk: string | undefined) {
  say("Brand recovery flow");
  const brand = z.looseObject({
    brand_uuid: z.string(),
    domain: z.string(),
    flow_recovery: z.string().nullable(),
  });
  const current = must(
    await one(brand, "/core/brands/?default=true", "default brand"),
    "default brand",
  );
  if (flowPk !== undefined && current.flow_recovery === flowPk) {
    say(`  ok      brand ${current.domain}`);
    return;
  }
  if (current.flow_recovery !== null && current.flow_recovery !== flowPk)
    say(
      `  note    brand ${current.domain} recovery flow was ${current.flow_recovery}`,
    );
  await write(
    `set brand ${current.domain} recovery flow to ${RECOVERY_FLOW_SLUG}`,
    () =>
      call(brand, "PATCH", `/core/brands/${current.brand_uuid}/`, {
        flow_recovery: flowPk,
      }),
  );
}

async function ensureProvisioning() {
  say("Provisioning account and role");
  const role = z.looseObject({ pk: z.string(), name: z.string() });
  const user = z.looseObject({
    pk: z.number(),
    type: z.string(),
    roles: z.array(z.string()).optional(),
  });

  const currentRole =
    (await one(
      role,
      `/rbac/roles/?search=${q(PROVISIONING_ROLE)}&name=${q(PROVISIONING_ROLE)}`,
      "role",
    ).then((r) => (r && r.name === PROVISIONING_ROLE ? r : undefined))) ??
    (await write(`create role ${PROVISIONING_ROLE}`, () =>
      call(role, "POST", "/rbac/roles/", { name: PROVISIONING_ROLE }),
    ));

  const account =
    (await one(
      user,
      `/core/users/?username=${q(PROVISIONING_ACCOUNT)}`,
      "account",
    )) ??
    (await write(`create service account ${PROVISIONING_ACCOUNT}`, async () => {
      const made = await call(
        z.looseObject({ user_pk: z.number() }),
        "POST",
        "/core/users/service_account/",
        { name: PROVISIONING_ACCOUNT, create_group: false, expiring: false },
      );
      return { pk: made.user_pk, type: "service_account", roles: [] };
    }));
  if (account && account.type !== "service_account")
    throw new Error(
      `${PROVISIONING_ACCOUNT} exists but is not a service account`,
    );

  if (currentRole && account && !(account.roles ?? []).includes(currentRole.pk))
    await write(
      `give ${PROVISIONING_ACCOUNT} the role ${PROVISIONING_ROLE}`,
      () =>
        call(z.unknown(), "POST", `/rbac/roles/${currentRole.pk}/add_user/`, {
          pk: account.pk,
        }),
    );
  else if (currentRole && account)
    say(`  ok      ${PROVISIONING_ACCOUNT} has the role`);

  if (!currentRole) return account;
  const perm = z.looseObject({ codename: z.string(), app_label: z.string() });
  const have = (
    await list(perm, `/rbac/permissions/?role=${currentRole.pk}&page_size=500`)
  ).map((p) => `${p.app_label}.${p.codename}`);
  const plan = planPermissions(have);
  if (plan.add.length === 0 && plan.remove.length === 0)
    say(`  ok      role permissions`);
  if (plan.add.length > 0)
    await write(`grant ${plan.add.join(", ")}`, () =>
      call(
        z.unknown(),
        "POST",
        `/rbac/permissions/assigned_by_roles/${currentRole.pk}/assign/`,
        {
          permissions: plan.add,
        },
      ),
    );
  if (plan.remove.length > 0)
    await write(`revoke ${plan.remove.join(", ")}`, () =>
      call(
        z.unknown(),
        "PATCH",
        `/rbac/permissions/assigned_by_roles/${currentRole.pk}/unassign/`,
        {
          permissions: plan.remove,
        },
      ),
    );
  return account;
}

async function main(): Promise<number> {
  const urls = parseAppUrls(env.APP_URLS);
  if (!urls.ok) {
    console.error(urls.error);
    return 1;
  }
  say(
    `${apply ? "Applying" : "Dry run (pass --apply to write)"} against ${env.AUTHENTIK_URL}`,
  );
  say(`App URLs: ${urls.urls.join(", ")}\n`);

  const provider = await ensureProvider(urls.urls);
  await ensureApplication(provider?.pk);
  await ensureAdminGroup();
  const flowPk = await ensureRecoveryFlow();
  await ensureBrandRecovery(flowPk);
  const account = await ensureProvisioning();
  say(
    `\nLearner path: ${LEARNER_PATH} (Authentik creates a path when the first user is put in it; nothing to set up)`,
  );

  if (!provider || !apply) {
    say("\nDry run done. Nothing was written.");
    return 0;
  }
  say(`\nAUTHENTIK_CLIENT_ID=${provider.client_id}`);
  const out = args["secret-out"];
  if (out) {
    writeFileSync(out, provider.client_secret, { mode: 0o600 });
    say(
      `Client secret written to ${out} (use it as AUTHENTIK_CLIENT_SECRET_FILE)`,
    );
  } else say(`Client secret: ${provider.client_secret}`);
  say(
    [
      "",
      "Next, create the provisioning token (it never comes from this script):",
      "  1. Admin interface → Directory → Tokens and App passwords → Create",
      `  2. User: ${PROVISIONING_ACCOUNT}${account ? ` (pk ${account.pk})` : ""}, intent API, set an expiry (rotate yearly)`,
      "  3. Copy it into a mode 600 file and point AUTHENTIK_PROVISIONING_TOKEN_FILE at it",
      `  4. Add each admin to ${ADMIN_GROUP} and turn on MFA for them`,
    ].join("\n"),
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error("authentik:setup:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
