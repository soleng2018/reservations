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
let auth; const seen = []; const writes = [];
p.on("request", (rq) => {
  const u = new URL(rq.url());
  if (rq.method() !== "GET" && u.host === "u1.nile-global.cloud") writes.push({ m: rq.method(), path: u.pathname + u.search, body: rq.postData() });
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

await p.waitForTimeout(6000);
await p.goto(`${base}/global-settings/advanced`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
const box = p.locator('input[type="checkbox"]').first();
await box.waitFor({ state: "attached", timeout: 30000 });
const lbl = await box.evaluate(e => (e.closest("label, div")?.innerText || ""));
if (!/Guest Service Auth and Geo Control/.test(lbl)) { console.log("first checkbox is not the Guest one, stopping:", lbl.slice(0, 60)); await b.close(); process.exit(1); }
const state = async () => await box.isChecked();



const H = { ...auth, "content-type": "application/json" };
const getAdv = async () => { const r = await ctx.request.get(`${base}/api/v1/guestpop/advance`, { headers: auth }); const j = await r.json(); return { status: r.status(), rec: Array.isArray(j) ? j[0] : j }; };
const snap = async (tag) => {
  const ss = await ctx.request.get(`${base}/api/v1/settings/ssids?size=2000`, { headers: auth }).then(r => r.json());
  const gp = await ctx.request.get(`${base}/api/v1/guestpop`, { headers: auth }).then(r => r.json());
  const out = { ssids: redact(ss.data.content.map(x => ({ name: x.instanceName, ssid: x.ssid, version: x.version }))), guestpop: redact(gp) };
  writeFileSync(`snap-${tag}.json`, JSON.stringify(out, null, 1));
  return out;
};

const before = await getAdv();
if (before.rec.tenantId !== "0be085a9-aa56-4af8-81bd-18677e67db63") { console.log("wrong tenant, stopping"); await b.close(); process.exit(1); }
const put = async (v) => { const r = await ctx.request.put(`${base}/api/v1/guestpop/advance/${before.rec.id}`, { headers: H, data: { id: before.rec.id, tenantId: before.rec.tenantId, advanceSettingsEnabled: v } }); return `${r.status()} enabled=${(await r.json().catch(() => ({}))).advanceSettingsEnabled}`; };

// The reset logic: read the state, then branch.
const resetGuestAdvance = async () => {
  const startOn = (await getAdv()).rec.advanceSettingsEnabled === true;
  console.log("state read:", startOn ? "ON" : "OFF");
  if (!startOn) {
    console.log("  OFF -> PUT true ->", await put(true));
    await new Promise(r => setTimeout(r, 10000));
    console.log("  waited 10 s");
  }
  console.log("  PUT false ->", await put(false));
  const end = (await getAdv()).rec.advanceSettingsEnabled;
  console.log("  GET after:", end, end === false ? "OK" : "NOT OFF");
};
console.log("=== test 1: starts OFF");
await resetGuestAdvance();
console.log("=== test 2: set ON first, then run the same logic");
console.log("  setup PUT true ->", await put(true));
await resetGuestAdvance();
console.log("FINAL", (await getAdv()).rec.advanceSettingsEnabled);
await b.close();
