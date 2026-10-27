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





const state = await ctx.storageState();
const PAGES = ["/network-setup/wireless", "/network-setup/access-management/wired", "/network-setup/dhcp", "/network-setup/authentication", "/network-setup/segments", "/global-settings/integrations", "/global-settings/advanced"];
const NEVER = [/\/api\/v1\/idps/, /\/api\/v1\/users/];
const furnitureRe = /sensor-metrics|alerts|valet|featureflags|userinfo|tenant-types|\/groups$|workorder|tags|\/sites|\/zones|\/buildings|\/floors|\/tenants?\/|wired-clients-status-summary|client-config-summary|client-feature|enablement|cloudradius\/eaptypes/;
const norm = (u) => { const x = new URL(u); return x.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}").replace(/\/00[a-z0-9]{18}/g, "/{id}"); };
const recs = (j) => { const l = Array.isArray(j) ? j : (j?.content ?? j?.data?.content ?? j?.data ?? null); return Array.isArray(l) ? l : (Array.isArray(j?.data) ? j.data : null); };
const per = {};
for (const pg of PAGES) {
  const c2 = await b.newContext({ storageState: state, viewport: { width: 1400, height: 900 } });
  const pp = await c2.newPage();
  const calls = new Map();
  pp.on("response", async (r) => { const u = new URL(r.url()); if (u.host !== "u1.nile-global.cloud" || !u.pathname.startsWith("/api/") || r.request().method() !== "GET") return; let j = null; try { j = JSON.parse(await r.text()); } catch { return; } const rows = recs(j); if (calls.get(norm(r.url()))?.list) return; calls.set(norm(r.url()), { method: r.request().method(), list: rows !== null && !(j && !Array.isArray(j) && !j.content && !j.data), n: rows?.length ?? 0, names: (rows ?? []).map(x => x?.name ?? x?.instanceName ?? x?.groupName ?? x?.type).filter(Boolean) }); });
  await pp.goto(base + pg, { waitUntil: "domcontentloaded" }); await pp.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await pp.waitForTimeout(6000);
  per[pg] = { calls, text: (await pp.locator("body").innerText()).toLowerCase(), signedOut: /sign in|idp-discovery/i.test(pp.url()) };
  await c2.close();
}
console.log("signed-in check:", PAGES.map(pg => per[pg].signedOut ? "OUT" : "ok").join(","));
const onPages = (k) => PAGES.filter(pg => per[pg].calls.has(k)).length;
for (const pg of PAGES.slice(0, 6)) {
  console.log("PAGE", pg);
  for (const [k, v] of per[pg].calls) {
    if (!v.list || furnitureRe.test(k)) continue;
    const never = NEVER.some(re => re.test(k));
    const shown = v.names.filter(n => per[pg].text.includes(String(n).toLowerCase()));
    console.log(`   ${never ? "[NEVER TOUCH] " : ""}${k}  items=${v.n}  onPages=${onPages(k)}  ${v.n === 0 ? "empty" : shown.length ? "shown: " + shown.slice(0, 3).join(", ") : "not shown"}`);
  }
}
await b.close();
