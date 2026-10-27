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
  if (rq.method() !== "GET" && u.host === "u1.nile-global.cloud" && !/alerts|intercom|collect/.test(u.pathname)) console.log("WRITE", rq.method(), u.pathname + u.search);
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




await p.waitForTimeout(3000);
await p.goto(`${base}/network-setup/authentication`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
seen.length = 0;
await p.mouse.click(250, 242);
await p.waitForTimeout(8000);

const SECRETY2 = /pass|secret|token|psk|key|credential|privatekey|pkcs|keystore|pfx/i;
const red = (v) => Array.isArray(v) ? v.map(red) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRETY2.test(k) ? "<hidden>" : red(x)])) : (typeof v === "string" && v.length > 80 ? v.slice(0, 40) + "..." : v);
const g = async (path) => { const r = await ctx.request.get(base + path, { headers: auth }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { status: r.status(), j }; };





const H = { ...auth, "content-type": "application/json" };
const getDefault = async () => { const sets = (await g("/api/v1/cloudradius/policysets")).j; for (const ps of sets) for (const pol of ps.policies) if (pol.isDefault === true) return { setId: ps.id, pol }; };
const before = await getDefault();
console.log("BEFORE:", before.pol.name, "authResult", before.pol.authResult);
if (before.pol.authResult === "REJECT") { console.log("already REJECT, nothing to do"); await b.close(); process.exit(0); }
const body = { ...before.pol, authResult: "REJECT" };
const url = `${base}/api/v1/cloudradius/policysets/${before.setId}/policies/${before.pol.id}`;
const r = await ctx.request.put(url, { headers: H, data: body });
const t = await r.text();
console.log("PUT ->", r.status(), t.slice(0, 300).replace(/"(private|secret|key)[^,]*,?/gi, "<hidden>"));
const after = await getDefault();
console.log("AFTER:", after.pol.name, "authResult", after.pol.authResult);
const diff = Object.keys({ ...before.pol, ...after.pol }).filter(k => JSON.stringify(before.pol[k]) !== JSON.stringify(after.pol[k]));
console.log("fields that changed:", JSON.stringify(diff));
await b.close();
