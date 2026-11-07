import { chromium } from "playwright";
import { readFileSync } from "node:fs";
// UI capture of Network Setup, Users (2026-11-07, Workshop 2). Selects the rows
// named on the command line, clicks De Activate, then Delete, and prints each
// API call the page makes. DELETES USERS ON A LIVE TENANT. Never pass the
// RootAdmin or the admin the run signs in as (this script refuses them).
// Run:  node 14-users-ui-capture.mjs 2 jane.do@nileworkshop-2.com kamal@nileworkshop-2.com
const pw = readFileSync(`${process.env.HOME}/secrets/nileportal.pw`, "utf8").trim();
const [n, ...targets] = process.argv.slice(2);
const user = `admin@nileworkshop-${n}.com`;
const base = "https://u1.nile-global.cloud";
if (!n || targets.length === 0) { console.log("usage: <workshop> <email>..."); process.exit(1); }
if (targets.some(t => t === user || /^nileadmin@/.test(t))) { console.log("refusing the signed in admin or the RootAdmin"); process.exit(1); }
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await ctx.newPage();
const calls = [];
p.on("response", async (rs) => {
  const rq = rs.request(); const u = new URL(rq.url());
  if (u.host !== "u1.nile-global.cloud" || !u.pathname.startsWith("/api/") || !["xhr", "fetch"].includes(rq.resourceType())) return;
  if (rq.method() !== "GET") calls.push(`${rq.method()} ${u.pathname}${u.search} ${rs.status()} body=${rq.postData() ?? ""}`);
});
await p.goto(base, { waitUntil: "domcontentloaded", timeout: 45000 });
await p.waitForSelector("#idp-discovery-username", { timeout: 30000 });
await p.fill("#idp-discovery-username", user);
await p.click("#idp-discovery-submit");
await p.waitForURL(/authentik/, { timeout: 40000 });
const uid = p.locator('input[name="uidField"]');
await uid.waitFor({ timeout: 30000 }); await uid.fill(user); await p.keyboard.press("Enter");
await p.getByText("Password", { exact: true }).first().waitFor({ timeout: 30000 });
await p.waitForTimeout(2500);
const pwBox = p.locator('input[type="password"]').first();
await pwBox.click(); await pwBox.fill(pw);
await p.getByRole("button", { name: /continue/i }).click();
await p.waitForURL(u => !/authentik/.test(u.host), { timeout: 60000 });
await p.waitForTimeout(6000);
await p.goto(`${base}/network-setup/users`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
for (const [button, label] of [["de_activate", "DEACTIVATE"], ["delete", "DELETE"]]) {
  for (const e of targets) await p.locator("tr", { hasText: e }).locator('input[type="checkbox"]').check();
  await p.waitForTimeout(800);
  await p.locator(`#users-action-${button}`).click();   // opens a Yes/No dialog, no API call yet
  await p.locator("#confirm-modal-yes-btn").click();
  await p.waitForTimeout(6000);
  console.log(label + ":\n" + calls.splice(0).join("\n"));
}
await b.close();
