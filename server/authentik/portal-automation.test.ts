import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import {
  ensureAutomationCredential,
  generatePassword,
  PASSWORD_LENGTH,
} from "./portal-automation";
import {
  fakeAuthentik,
  fakeGroup,
  fakeUser,
  markedGroup,
  ADMINS,
} from "./testing";

const DOMAIN = "nileworkshop-4.com";
const GROUP = "NileWorkshop4Admin";
const group = () => markedGroup("ws4-uuid", GROUP, {}, DOMAIN);
const testbed = { domain: DOMAIN, groupName: GROUP };
const NAME = `automation@${DOMAIN}`;

describe("generatePassword", () => {
  it("is 40 characters with a letter, a digit, and a symbol", () => {
    const p = generatePassword();
    expect(p).toHaveLength(PASSWORD_LENGTH);
    expect(p).toMatch(/[A-Za-z]/);
    expect(p).toMatch(/[0-9]/);
    expect(p).toMatch(/[^A-Za-z0-9]/);
  });

  it("differs every time", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("ensureAutomationCredential", () => {
  it("creates the marked user once, adds it to the group, and sets a password", async () => {
    const fake = fakeAuthentik([], { groups: [group()] });
    const r = await ensureAutomationCredential(fake.api, testbed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toBe(true);
    expect(r.value.username).toBe(NAME);
    const user = fake.users.find((u) => u.username === NAME);
    expect(user?.attributes).toMatchObject({
      hol_portal_automation: true,
      mail: NAME,
    });
    expect(user?.attributes.hol_learner).toBeUndefined();
    expect(user?.groups).toEqual(["ws4-uuid"]);
    expect(fake.writes).toEqual([
      "POST /core/users/",
      "POST /core/groups/ws4-uuid/add_user/",
      expect.stringMatching(/^POST \/core\/users\/\d+\/set_password\/$/),
    ]);
    // The password is set once and equals the secret's value.
    expect(fake.passwords.get(user?.pk ?? 0)).toBe(r.value.password.reveal());
  });

  it("creates nothing the second time and sets a new password", async () => {
    const fake = fakeAuthentik([], { groups: [group()] });
    const a = await ensureAutomationCredential(fake.api, testbed);
    fake.writes.length = 0;
    const b = await ensureAutomationCredential(fake.api, testbed);
    if (!a.ok || !b.ok) throw new Error("expected both to pass");
    expect(b.value.created).toBe(false);
    expect(fake.writes).toEqual([
      expect.stringMatching(/^POST \/core\/users\/\d+\/set_password\/$/),
    ]);
    expect(b.value.password.reveal()).not.toBe(a.value.password.reveal());
  });

  it("adds a missing group membership and nothing else", async () => {
    const fake = fakeAuthentik([], { groups: [group()] });
    await ensureAutomationCredential(fake.api, testbed);
    const user = fake.users.find((u) => u.username === NAME);
    if (!user) throw new Error("user missing");
    user.groups = [];
    fake.writes.length = 0;
    const r = await ensureAutomationCredential(fake.api, testbed);
    expect(r.ok).toBe(true);
    expect(user.groups).toEqual(["ws4-uuid"]);
    expect(fake.writes).toHaveLength(2);
  });

  it("keeps the password out of printing, JSON, and inspect", async () => {
    const fake = fakeAuthentik([], { groups: [group()] });
    const r = await ensureAutomationCredential(fake.api, testbed);
    if (!r.ok) throw new Error("expected ok");
    const plain = r.value.password.reveal();
    expect(String(r.value.password)).not.toContain(plain);
    expect(JSON.stringify(r.value)).not.toContain(plain);
    expect(inspect(r.value)).not.toContain(plain);
  });

  it.each([
    ["an unmarked user of that name", { attributes: {} }],
    [
      "a superuser",
      { is_superuser: true, attributes: { hol_portal_automation: true } },
    ],
    [
      "a member of hol-admins",
      { groups: [ADMINS.pk], attributes: { hol_portal_automation: true } },
    ],
  ])("writes nothing for %s", async (_n, over) => {
    const fake = fakeAuthentik(
      [fakeUser({ pk: 55, username: NAME, ...over })],
      { groups: [group()] },
    );
    const r = await ensureAutomationCredential(fake.api, testbed);
    expect(r).toEqual({ ok: false, error: "refused" });
    expect(fake.writes).toEqual([]);
    expect(fake.passwords.size).toBe(0);
  });

  it.each([
    [
      "a group without the marker",
      fakeGroup("ws4-uuid", GROUP, { hol_testbed_domain: DOMAIN }),
    ],
    [
      "a group for another domain",
      markedGroup("ws4-uuid", GROUP, {}, "nileworkshop-5.com"),
    ],
    ["a group with no domain", markedGroup("ws4-uuid", GROUP)],
  ])("writes nothing for %s", async (_n, g) => {
    const fake = fakeAuthentik([], { groups: [g] });
    const r = await ensureAutomationCredential(fake.api, testbed);
    expect(r).toEqual({ ok: false, error: "refused" });
    expect(fake.writes).toEqual([]);
  });

  it("says group_missing when the group does not exist", async () => {
    const fake = fakeAuthentik([]);
    const r = await ensureAutomationCredential(fake.api, testbed);
    expect(r).toEqual({ ok: false, error: "group_missing" });
    expect(fake.writes).toEqual([]);
  });

  it("says failed when Authentik is down", async () => {
    const fake = fakeAuthentik([], { groups: [group()], down: true });
    const r = await ensureAutomationCredential(fake.api, testbed);
    expect(r).toEqual({ ok: false, error: "failed" });
  });

  it("never writes for an admin@ user, a learner, or another domain", async () => {
    const fake = fakeAuthentik(
      [
        fakeUser({ pk: 60, username: `admin@${DOMAIN}` }),
        fakeUser({
          pk: 61,
          username: "learner@x.test",
          attributes: { hol_learner: true },
        }),
      ],
      { groups: [group()] },
    );
    await ensureAutomationCredential(fake.api, testbed);
    const touched = fake.writes.filter((w) =>
      /\/core\/users\/(60|61)\//.test(w),
    );
    expect(touched).toEqual([]);
  });
});
