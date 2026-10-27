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
const listWired = async () => { const r = await ctx.request.get(`${base}/api/v1/client-configs?size=2000`, { headers: auth }); return (await r.json()).map(x => x.clientConfig); };
const ssoEnabled = async () => { const j = await ctx.request.get(`${base}/api/v1/settings/sso-segment`, { headers: auth }).then(r => r.json()); return !!(j.ssoSegment?.preTransactionSegment && j.ssoSegment?.postTransactionSegment); };
const show = (a) => a.length ? a.map(c => `${c.macAddress}[${c.ruleType}/${c.state}]`).join(", ") : "(none)";
const delIds = async (ids) => { if (!ids.length) return "nothing to delete"; if (ids.some(i => !i.startsWith(TENANT + "-"))) throw new Error("id from another tenant"); const r = await ctx.request.delete(`${base}/api/v1/client-configs`, { headers: H, data: { ids } }); return `${r.status()} ${(await r.text()).slice(0, 100)}`; };

const resetWired = async () => {
  const enabled = await ssoEnabled();
  const entries = await listWired();
  console.log("Wired SSO enabled:", enabled);
  console.log("entries:", show(entries));
  if (enabled) {
    console.log("1. delete all except ALL ->", await delIds(entries.filter(c => c.ruleType !== "ALL").map(c => c.id)));
    const r = await ctx.request.delete(`${base}/api/v1/settings/sso-segment`, { headers: auth });
    console.log("2. delete Wired SSO config ->", r.status());
    console.log("   SSO enabled now:", await ssoEnabled());
    console.log("3. delete ALL ->", await delIds((await listWired()).filter(c => c.ruleType === "ALL").map(c => c.id)));
  } else {
    console.log("delete all entries ->", await delIds(entries.map(c => c.id)));
  }
  await new Promise(r => setTimeout(r, 4000));
  console.log("AFTER entries:", show(await listWired()), "| SSO enabled:", await ssoEnabled());
};
await resetWired();
await b.close();
