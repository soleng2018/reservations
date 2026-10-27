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
await p.goto(`${base}/network-setup/wireless`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 30 && !auth?.["x-id-token"]; i++) await p.waitForTimeout(1000);
await p.waitForTimeout(4000);
console.log("final url:", p.url().replace(/\?.*/, ""));
console.log("auth captured:", !!auth?.["x-id-token"]);
await p.screenshot({ path: `wireless-${n}.png` });

const tenant = await ctx.request.get(`${base}/api/v1/userinfo`, { headers: auth }).then(r => r.json());
const t = await ctx.request.get(`${base}/api/tenants/${tenant.tenantId}`, { headers: auth }).then(r => r.json());
console.log("tenant:", t.name);
if (!new RegExp(`^Nile Workshop[- ]${n}$`).test(t.name)) { console.log("WRONG TENANT, stopping"); await b.close(); process.exit(1); }
const list = async () => { const r = await ctx.request.get(`${base}/api/v1/settings/ssids?size=2000`, { headers: auth }); const j = await r.json(); return { status: r.status(), arr: j.data.content }; };
const show = (a) => a.map(x => `${x.instanceName}${x.ssid.popTunnelUsed ? " [PROTECTED]" : ""}`).join(", ");
const before = await list();
console.log("BEFORE", before.status, show(before.arr));
const protectedOnes = before.arr.filter(x => x.ssid.popTunnelUsed === true);
if (protectedOnes.length !== 1) { console.log("expected exactly 1 protected SSID, found", protectedOnes.length, "- stopping"); await b.close(); process.exit(1); }
const targets = before.arr.filter(x => x.ssid.popTunnelUsed !== true);
const ordered = [...targets.filter(x => x.instanceName === "Guest"), ...targets.filter(x => x.instanceName !== "Guest")];
let first = true;
for (const x of ordered) {
  const r = await ctx.request.delete(`${base}/api/v1/settings/ssids/${x.id}`, { headers: auth });
  console.log(`DELETE ${x.instanceName} ->`, r.status(), (await r.text()).slice(0, 150));
  if (first) { first = false; const mid = await list(); console.log("after first:", show(mid.arr)); if (r.status() >= 300) { console.log("first delete failed, stopping"); break; } }
}
const after = await list();
console.log("AFTER", after.status, show(after.arr));
// repeat pass: nothing deletable should remain
console.log("deletable left:", after.arr.filter(x => x.ssid.popTunnelUsed !== true).length, "| protected still present:", after.arr.some(x => x.ssid.popTunnelUsed === true));
await p.goto(`${base}/network-setup/wireless`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(6000);
await p.screenshot({ path: `after-delete-${n}.png` });
await b.close();
