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



const TENANT = "0be085a9-aa56-4af8-81bd-18677e67db63";
const get = async (path) => { const r = await ctx.request.get(base + path, { headers: auth }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = []; } return { status: r.status(), j }; };
const errText = (t) => { try { const j = JSON.parse(t); return j.errors?.map(e => e.message).join("; ") ?? t.slice(0, 160); } catch { return t.slice(0, 160); } };
const rows = (r) => { const b2 = r.j; const l = Array.isArray(b2) ? b2 : (b2?.content ?? b2?.data?.content ?? b2?.data ?? []); return Array.isArray(l) ? l : []; };
const TYPES = [
  { name: "webhook", list: "/api/v1/subscriptions/webhooks/config?size=2000", del: (id) => `/api/v1/subscriptions/webhooks/config/${id}`, label: (x) => x.name, verified: true },
  { name: "SIEM (all vendors)", list: "/api/v1/siems?size=2000", del: (id) => `/api/v1/siems/${id}`, label: (x) => x.type ?? x.instance, verified: true },
  { name: "email", list: "/api/v1/subscriptions/email?size=2000", del: (id) => `/api/v1/subscriptions/email/${id}`, label: (x) => `${x.subNotificationType} -> a recipient`, verified: false },
  { name: "DNS (ddns)", list: "/api/v1/dhcp/ddns/ddns-servers?page=0&size=500", del: (id) => `/api/v1/dhcp/ddns/ddns-servers/${id}`, label: (x) => x.name ?? x.id, verified: false }];
const failures = [];
for (const t of TYPES) {
  const items = rows(await get(t.list));
  console.log(`TYPE ${t.name}: ${items.length} found${t.verified ? "" : " (delete route UNVERIFIED)"}`);
  if (items.some(x => x.tenantId && x.tenantId !== TENANT)) { console.log("  wrong tenant, stopping"); await b.close(); process.exit(1); }
  for (const x of items) {
    const r = await ctx.request.delete(base + t.del(x.id), { headers: auth });
    const ok = r.status() < 300;
    console.log(`  DELETE ${t.label(x)} -> ${r.status()}${ok ? "" : " " + errText(await r.text())}`);
    if (!ok) failures.push(`${t.name}:${t.label(x)}`);
  }
}
await new Promise(r => setTimeout(r, 2500));
let left = 0;
for (const t of TYPES) { const n = rows(await get(t.list)).length; left += n; console.log("AFTER", t.name, n); }
console.log("LEFTOVER integrations:", left, "| failed deletes:", failures.length ? failures.join(", ") : "none");
await b.close();
