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
  if (rq.method() !== "GET" && u.host === "u1.nile-global.cloud" && !/alerts|intercom/.test(u.pathname)) console.log("WRITE", rq.method(), u.pathname + u.search, (rq.postData() || "").slice(0, 300));
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







await p.waitForTimeout(4000);


await p.waitForTimeout(4000);
await p.locator("text=SECURITY").first().click();
await p.waitForTimeout(1500);


const get = async (path) => { const r = await ctx.request.get(base + path, { headers: auth }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status(), j }; };
const cut = (o, n = 700) => JSON.stringify(redact(o)).slice(0, n);


await p.goto(`${base}/security-settings/trust-engine/enterprise/policySets`, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(6000);
await p.getByText("Global Default Policy Set", { exact: true }).first().click(); await p.waitForTimeout(5000);
await p.getByRole("button", { name: /^list$/i }).or(p.getByText("List", { exact: true })).first().click();
await p.waitForTimeout(3000);
p.on("response", async r => { if (r.request().method() !== "GET" && /nile-global/.test(r.url()) && !/alerts|intercom/.test(r.url())) console.log("RESPONSE", r.status(), r.request().method(), new URL(r.url()).pathname, (await r.text().catch(() => "")).slice(0, 300)); });
const rowOf = (name) => p.locator("tr", { hasText: name }).first();
await rowOf("dfdsfds").locator('input[type="checkbox"]').first().click({ force: true });
await p.waitForTimeout(800);
const nChecked = await p.locator('tbody input[type="checkbox"]:checked').count();
console.log("checked rows:", nChecked);
if (nChecked !== 1) { console.log("expected 1 checked, stopping"); await b.close(); process.exit(1); }
await p.getByRole("button", { name: /^delete$/i }).first().click();
await p.waitForTimeout(2000);
console.log("dialog:", JSON.stringify(await p.$$eval('[role="dialog"], [role="alertdialog"]', els => els.map(e => e.innerText.replace(/\s+/g, " ").slice(0, 300)).filter(Boolean))));
await p.locator('[role="dialog"] button, [role="alertdialog"] button').filter({ hasText: /^(yes|ok|confirm|delete)$/i }).first().click();
await p.waitForTimeout(3000);
console.log("list after delete:", (await p.locator("tbody").innerText()).replace(/\s+/g, " ").slice(0, 200));
await p.getByRole("button", { name: /^done$/i }).click();
await p.waitForTimeout(5000);
const ps = await ctx.request.get(`${base}/api/v3/policy/policysets`, { headers: auth }).then(r => r.json());
console.log("policies now:", ps.content[0].policies.map(x => x.name).join(" | "));
await b.close();
