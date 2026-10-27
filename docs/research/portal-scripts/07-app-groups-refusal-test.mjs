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





const H = { ...auth, "content-type": "application/json" };
const groups = async () => { const gr = await ctx.request.get(`${base}/api/v3/policy/groups?size=2000`, { headers: auth }).then(r => r.json()); return gr.content ?? gr; };
const before = await groups();
console.log("before:", before.map(x => x.name).join(", "));
for (const name of ["External DNS", "Internet", "External", "Local"]) {
  const g = before.find(x => x.name === name && x.groupType === "App");
  if (!g) { console.log(name, "not found"); continue; }
  const r = await ctx.request.delete(`${base}/api/v3/policy/groups/${g.id}`, { headers: H, data: { id: g.id } });
  const t = (await r.text()).slice(0, 200);
  console.log(name.padEnd(13), "->", r.status(), t);
  if (r.status() < 300) { console.log("ACCEPTED, stopping"); break; }
}
console.log("after:", (await groups()).map(x => x.name).join(", "));
await b.close();
