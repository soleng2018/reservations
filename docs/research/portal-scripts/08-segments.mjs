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
  if (rq.method() !== "GET" && u.host === "u1.nile-global.cloud") console.log("WRITE", rq.method(), u.pathname);
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







const H = { ...auth, "content-type": "application/json" };
const TENANT = "0be085a9-aa56-4af8-81bd-18677e67db63";
const list = async () => { const r = await ctx.request.get(`${base}/api/v1/settings/segments?size=2000`, { headers: auth }); const j = await r.json(); return { status: r.status(), arr: j.data.content }; };
const before = await list();
console.log("BEFORE", before.status, before.arr.map(x => x.instanceName).join(", "));
if (before.arr.some(x => x.tenantId !== TENANT)) { console.log("wrong tenant, stopping"); await b.close(); process.exit(1); }
const msg = (t) => { try { const j = JSON.parse(t); return j.errors?.map(e => e.message).join("; ") ?? t.slice(0, 200); } catch { return t.slice(0, 200); } };
for (const seg of before.arr) {
  const r1 = await ctx.request.delete(`${base}/api/v1/settings/segments/${seg.id}`, { headers: auth });
  const t1 = await r1.text();
  console.log(`${seg.instanceName.padEnd(11)} id only      ->`, r1.status(), r1.status() >= 300 ? msg(t1) : "");
  if (r1.status() >= 300) {
    const r2 = await ctx.request.delete(`${base}/api/v1/settings/segments/${seg.id}`, { headers: H, data: seg });
    console.log(`${seg.instanceName.padEnd(11)} full record  ->`, r2.status(), r2.status() >= 300 ? msg(await r2.text()) : "");
  }
}
await p.waitForTimeout(2000);
const after = await list();
console.log("AFTER", after.status, after.arr.length ? after.arr.map(x => x.instanceName).join(", ") : "(none)");
await b.close();
