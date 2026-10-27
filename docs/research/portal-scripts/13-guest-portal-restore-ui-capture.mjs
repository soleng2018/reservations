import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const pw = readFileSync(`${process.env.HOME}/secrets/nileportal.pw`, "utf8").trim();
const n = process.argv[2] ?? "4";
const user = `admin@nileworkshop-${n}.com`;
const base = "https://u1.nile-global.cloud";
const SECRETY = /pass|secret|token|psk|key|credential|cookie|sharedsecret/i;
const redact = (v) => Array.isArray(v) ? v.map(redact) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRETY.test(k) ? "<hidden>" : redact(x)])) : v;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();
let auth; const seen = [];
p.on("request", (rq) => {
  const u = new URL(rq.url());
  if (u.host === "u1.nile-global.cloud" && u.pathname.startsWith("/api/") && ["xhr","fetch"].includes(rq.resourceType())) seen.push(`${rq.method()} ${u.pathname}${u.search}`);
  if (!auth && rq.url().startsWith(`${base}/api/v1/settings/ssids`)) { const h = rq.headers(); auth = { "x-id-token": h["x-id-token"], "x-nile-client": h["x-nile-client"], "x-requested-with": h["x-requested-with"] }; }
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
await p.waitForURL(u => !/authentik/.test(u.host), { timeout: 60000 }).catch(() => console.log("LOGIN: still on", p.url().replace(/\?.*/, "")));


await p.waitForTimeout(5000);
await p.getByText("GLOBAL", { exact: false }).first().click();
await p.waitForTimeout(3000);
const menu = await p.$$eval('[role="menuitem"], [role="menu"] li, #global-settings-menu *', els => [...new Set(els.map(e => e.innerText?.trim()).filter(t => t && t.length < 40))]);
console.log("MENU:", JSON.stringify(menu));


const SEC = /pass|secret|token|key|credential/i;
const shape = (v, d = 0) => Array.isArray(v) ? [shape(v[0], d + 1), `x${v.length}`] : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SEC.test(k) ? "<hidden>" : (d > 4 ? typeof x : shape(x, d + 1))])) : (typeof v === "string" ? (v.length > 60 ? v.slice(0, 40) + "..." : v) : v);
const read = async () => { const r = await ctx.request.get(`${base}/api/v1/cloud-profile/map/0be085a9-aa56-4af8-81bd-18677e67db63?profile_type=app_profile&scope_type=tenant`, { headers: auth }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { status: r.status(), j }; };
p.on("response", async r => { if (r.request().method() !== "GET" && /nile-global/.test(r.url()) && !/alerts|intercom|collect/.test(r.url())) console.log("RESPONSE", r.status(), r.request().method(), new URL(r.url()).pathname, (await r.text().catch(() => "")).slice(0, 300)); });
await p.goto(`${base}/global-settings/guest-portal`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const before = await read();
console.log("BEFORE", before.status, JSON.stringify(shape(before.j)).slice(0, 1200));
console.log("UI before:", JSON.stringify(await p.$$eval("input", els => els.map(e => e.value).filter(v => v && v.length < 40))));
await p.getByText("Restore to default", { exact: true }).first().click();
await p.waitForTimeout(2500);
console.log("DIALOG:", JSON.stringify(await p.$$eval('[role="dialog"], [role="alertdialog"]', els => els.map(e => e.innerText.replace(/\s+/g, " ").slice(0, 300)).filter(Boolean))));
const yes = p.locator('[role="dialog"] button, [role="alertdialog"] button').filter({ hasText: /^(yes|ok|confirm|restore|continue)$/i });
if (await yes.count()) { await yes.first().click(); await p.waitForTimeout(3000); }
console.log("UI after restore:", JSON.stringify(await p.$$eval("input", els => els.map(e => e.value).filter(v => v && v.length < 40))));
const saveBtn = p.getByRole("button", { name: /^save$/i });
const saveEnabled = await saveBtn.isEnabled().catch(() => false);
console.log("SAVE enabled:", saveEnabled);
await p.screenshot({ path: "guestportal-restored.png" });
if (saveEnabled) { await saveBtn.click(); await p.waitForTimeout(4000); console.log("TEXT after save:", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(-200)); }
const after = await read();
console.log("AFTER", after.status, JSON.stringify(shape(after.j)).slice(0, 1200));
await b.close();
