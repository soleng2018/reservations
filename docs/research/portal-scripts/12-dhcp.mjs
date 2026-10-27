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
const TENANT = "0be085a9-aa56-4af8-81bd-18677e67db63";
const msg = (t) => { try { const j = JSON.parse(t); return j.errors?.map(e => e.message).join("; ") ?? t.slice(0, 200); } catch { return t.slice(0, 200); } };
const list = async () => (await g("/api/v1/settings/dhcp-clients?size=2000")).j.data.content;
const isNile = (x) => x.dhcpClient?.cloudDHCP === true;
const scopesOf = (x) => x.dhcpClient?.servers?.[0]?.subnets ?? [];
const show = (a) => a.map(x => `${x.instanceName}${isNile(x) ? " [NILE, " + scopesOf(x).length + " scopes]" : " [" + scopesOf(x).length + " subnets]"}`).join(", ");

let recs = await list();
console.log("STATE before:", show(recs));
if (recs.some(x => x.tenantId !== TENANT)) { console.log("wrong tenant, stopping"); await b.close(); process.exit(1); }
if (recs.filter(isNile).length !== 1) { console.log("expected exactly one cloudDHCP record, stopping"); await b.close(); process.exit(1); }

console.log("STEP a: admin DHCP servers");
const admins = recs.filter(x => !isNile(x));
if (!admins.length) console.log("  none: nothing to do");
for (const x of admins) { const r = await ctx.request.delete(`${base}/api/v1/settings/dhcp-clients/${x.id}`, { headers: auth }); console.log(`  DELETE ${x.instanceName} ->`, r.status(), r.status() >= 300 ? msg(await r.text()) : ""); }

console.log("STEP b: Nile DHCP scopes");
const putScopes = async (rec, subnets) => { const body = structuredClone(rec); body.dhcpClient.servers[0].subnets = subnets; const r = await ctx.request.put(`${base}/api/v1/settings/dhcp-clients/${rec.id}`, { headers: H, data: body }); return { status: r.status(), text: r.status() >= 300 ? msg(await r.text()) : "" }; };
let nile = (await list()).find(isNile);
const n0 = scopesOf(nile).length;
console.log("  scopes found:", n0, scopesOf(nile).map(s => s.prefix).join(", "));
if (n0 === 0) console.log("  no scopes: nothing to do");
else {
  const one = await putScopes(nile, []);
  console.log("  single PUT with an empty subnets list ->", one.status, one.text);
  nile = (await list()).find(isNile);
  console.log("  scopes left after the single PUT:", scopesOf(nile).length);
  let guard = 0;
  while (scopesOf(nile).length > 0 && guard++ < 10) {
    const rest = scopesOf(nile).slice(1);
    const r = await putScopes(nile, rest);
    console.log(`  fallback PUT removing ${scopesOf(nile)[0].prefix} ->`, r.status, r.text);
    if (r.status >= 300) break;
    nile = (await list()).find(isNile);
  }
}
await new Promise(r => setTimeout(r, 2000));
console.log("STATE after:", show(await list()));
await b.close();
