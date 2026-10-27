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





const TENANT = "0be085a9-aa56-4af8-81bd-18677e67db63";
const cfgId = "eee25f55-e8b7-4adf-aaf3-de6f58f8625e";
const msg = (t) => { try { const j = JSON.parse(t); return j.errors?.map(e => e.message).join("; ") ?? t.slice(0, 160); } catch { return t.slice(0, 160); } };
const del = async (label, path) => { const r = await ctx.request.delete(base + path, { headers: auth }); const t = await r.text(); console.log(`  DELETE ${label} -> ${r.status()}${r.status() >= 300 ? " " + msg(t) : ""}`); return r.status(); };
const isCloud = (x) => (x.radius?.cloudRadius ?? x.cloudRadius) === true;

console.log("STEP 8a admin RADIUS servers");
const rl = (await g("/api/v1/settings/radius?size=2000")).j.data.content;
console.log("  list:", rl.map(x => `${x.instanceName}${isCloud(x) ? " [CLOUD]" : ""}`).join(", "));
if (rl.some(x => x.tenantId !== TENANT)) { console.log("wrong tenant, stopping"); await b.close(); process.exit(1); }
if (rl.filter(isCloud).length !== 1) { console.log("expected exactly one cloud RADIUS record, stopping"); await b.close(); process.exit(1); }
for (const x of rl.filter(x => !isCloud(x))) await del(x.instanceName, `/api/v1/settings/radius/${x.id}`);

console.log("STEP 8b Guest Portals");
const pl = (await g("/api/v1/portalconfig")).j;
console.log("  list:", pl.length ? pl.map(x => x.name).join(", ") : "(none)");
for (const x of pl) await del(x.name, `/api/v1/portalconfig/${x.id}`);

console.log("STEP 9 Nile RADIUS policies");
const sets = (await g("/api/v1/cloudradius/policysets")).j;
for (const ps of sets) {
  console.log("  set", ps.name, ":", ps.policies.map(x => `${x.name}${x.isDefault ? " [DEFAULT " + x.authResult + "]" : ""}`).join(", "));
  for (const pol of ps.policies.filter(x => x.isDefault !== true)) await del(pol.name, `/api/v1/cloudradius/policysets/${ps.id}/policies/${pol.id}`);
}
const sets2 = (await g("/api/v1/cloudradius/policysets")).j;
const dflt = sets2.flatMap(ps => ps.policies).find(x => x.isDefault === true);
console.log("  default policy authResult:", dflt?.authResult, dflt?.authResult === "REJECT" ? "(ok, no change)" : "(NOT REJECT: the call to change it is not known, reporting only)");

console.log("STEP 10 certificates and PEAP");
const cfg = (await g("/api/v1/cloudradius/config")).j;
const keys = (await g(`/api/v2/cloudradius/config/${cfg.id}/eaptlsconfig/keys`)).j;
const demo = await g("/api/v1/cloudradius/config/demo/keys");
const hasCerts = !!keys.serverCertMetadata || (keys.trustedCertMetadata ?? []).length > 0 || demo.status === 200;
console.log("  server cert:", !!keys.serverCertMetadata, "| trusted CAs:", (keys.trustedCertMetadata ?? []).length, "| demo client certs:", demo.status === 200 ? demo.j.clientCertificateDetails?.length : "none (" + demo.status + ")", "| PEAP complete:", cfg.eapPeapConfig?.complete);
if (hasCerts) await del("demo/keys (all certificates)", "/api/v1/cloudradius/config/demo/keys"); else console.log("  no certificates: nothing to do");
if (cfg.eapPeapConfig?.complete) console.log("  PEAP is configured but its delete call is not known: reporting only");
else console.log("  PEAP not configured: nothing to do");

await new Promise(r => setTimeout(r, 2500));
console.log("AFTER");
console.log("  RADIUS:", (await g("/api/v1/settings/radius?size=2000")).j.data.content.map(x => x.instanceName).join(", "));
console.log("  portals:", JSON.stringify((await g("/api/v1/portalconfig")).j.map(x => x.name)));
console.log("  policies:", (await g("/api/v1/cloudradius/policysets")).j.flatMap(ps => ps.policies).map(x => `${x.name}(${x.authResult})`).join(", "));
const c2 = (await g("/api/v1/cloudradius/config")).j; const k2 = (await g(`/api/v2/cloudradius/config/${c2.id}/eaptlsconfig/keys`)).j;
console.log("  certs: server", !!k2.serverCertMetadata, "| CAs", (k2.trustedCertMetadata ?? []).length, "| demo", (await g("/api/v1/cloudradius/config/demo/keys")).status, "| TLS complete", c2.eapTLSConfig?.complete, "| PEAP complete", c2.eapPeapConfig?.complete);
await b.close();
