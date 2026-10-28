import { expect, type Page } from "@playwright/test";
import { test } from "./admin-session";
import {
  accountMenu,
  ADMIN_ENTRY,
  haveSecrets,
  learner,
  signIn,
} from "./authentik";

// Spec 0009: the public landing at /.
const DESCRIPTION =
  "Reserve a remote Nile testbed with switches, access points, and wireless clients, and start testing in minutes.";

const STEPS = [
  ["Pick a lab type", "Choose the lab level that matches what you're testing."],
  [
    "Choose an open time",
    "See real-time availability in your own timezone, 24/7.",
  ],
  [
    "Get instant access",
    "Your lab links and session details arrive as soon as you book.",
  ],
] as const;

// The width and height from a JPEG's first SOF marker.
const jpegSize = (buf: Buffer): { width: number; height: number } => {
  for (let i = 2; i + 9 < buf.length;) {
    const marker = buf.readUInt16BE(i);
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3)
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      };
    i += 2 + length;
  }
  throw new Error("no SOF marker");
};

async function expectLanding(page: Page) {
  const main = page.getByRole("main");
  await expect(
    main.getByText("Nile Hands-On Labs", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Get hands-on with real Nile gear, from anywhere.",
    }),
  ).toBeVisible();
  await expect(
    main.getByText(
      "Reserve a remote testbed with switches, access points, and wireless clients, and start testing in minutes. No hardware to ship, no VPN to configure.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Reserve a lab" }),
  ).toHaveAttribute("href", "/book");
  await expect(
    page.getByRole("link", { name: "Manage an existing reservation" }),
  ).toHaveAttribute("href", "/reservations");
  for (const [title, body] of STEPS) {
    await expect(
      page.getByRole("heading", { level: 3, name: title }),
    ).toBeVisible();
    await expect(main.getByText(body)).toBeVisible();
  }
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  expect(
    hrefs.filter(
      (h) => h.includes(ADMIN_ENTRY) || h.includes("/auth/admin-entry"),
    ),
  ).toEqual([]);
}

// covers: AC-2, AC-3, AC-4
test("an anonymous visitor sees the landing and can start a booking", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expectLanding(page);
  await expect(accountMenu(page)).toHaveCount(0);

  const hero = page.locator('main img[src*="hol-hero.jpg"]');
  await expect(hero).toHaveAttribute("alt", "");
  await expect(hero).toHaveJSProperty("complete", true);
  expect((await hero.boundingBox())?.width).toBeLessThanOrEqual(520);
  const cardIcons = page.locator("main li svg");
  await expect(cardIcons).toHaveCount(3);
  for (const icon of await cardIcons.all())
    await expect(icon).toHaveAttribute("aria-hidden", "true");

  const html = await (await page.request.get("/")).text();
  expect(html).not.toContain(ADMIN_ENTRY);
  expect(html).not.toContain("/auth/admin-entry");

  await page.getByRole("link", { name: "Reserve a lab" }).click();
  await expect(page).toHaveURL(/\/book$/);
});

// covers: AC-4
test("on a phone the art follows the links and loads a smaller file", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto("/");
  const manage = page.getByRole("link", {
    name: "Manage an existing reservation",
  });
  const hero = page.locator('main img[src*="hol-hero.jpg"]');
  await expect(hero).toHaveJSProperty("complete", true);

  const linkBox = await manage.boundingBox();
  const heroBox = await hero.boundingBox();
  expect(heroBox?.y).toBeGreaterThan(
    (linkBox?.y ?? 0) + (linkBox?.height ?? 0),
  );
  expect(
    await manage.evaluate(
      (link, img) =>
        Boolean(
          img &&
          link.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await hero.elementHandle(),
    ),
  ).toBe(true);

  const src = await hero.evaluate((img: HTMLImageElement) => img.currentSrc);
  const w = Number(new URL(src).searchParams.get("w"));
  expect(w).toBeGreaterThan(0);
  expect(w).toBeLessThan(1920);
  await context.close();
});

// covers: AC-1
test("a signed in admin sees the same landing, not redirected", async ({
  adminPage: page,
}) => {
  test.skip(!haveSecrets, "hol-test passwords are not on this machine");
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expectLanding(page);
  await expect(accountMenu(page)).toBeVisible();
});

// covers: AC-1
test("a signed in learner sees the same landing, not redirected", async ({
  page,
}) => {
  test.skip(!haveSecrets, "hol-test passwords are not on this machine");
  await signIn(page, "/reservations", learner);
  await expect(accountMenu(page)).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expectLanding(page);
  await expect(accountMenu(page)).toBeVisible();
});

// covers: AC-6
test("/ sends its title, description, and social card", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "").origin;
  const image = `${origin}/brand/hol-social.jpg`;
  await page.goto("/");

  await expect(page).toHaveTitle("Nile Hands-On Labs");
  const meta = (selector: string) => page.locator(`meta[${selector}]`);
  const expected: readonly (readonly [string, string])[] = [
    ['name="description"', DESCRIPTION],
    ['name="robots"', "index, follow"],
    ['property="og:type"', "website"],
    ['property="og:site_name"', "Nile Hands-On Labs"],
    ['property="og:title"', "Nile Hands-On Labs"],
    ['property="og:description"', DESCRIPTION],
    // Next writes a URL whose path is only "/" as the bare origin.
    ['property="og:url"', origin],
    ['property="og:image"', image],
    ['property="og:image:width"', "1200"],
    ['property="og:image:height"', "630"],
    ['property="og:image:alt"', "Nile Hands-On Labs"],
    ['name="twitter:card"', "summary_large_image"],
    ['name="twitter:title"', "Nile Hands-On Labs"],
    ['name="twitter:description"', DESCRIPTION],
    ['name="twitter:image"', image],
  ];
  for (const [selector, content] of expected)
    await expect(meta(selector)).toHaveAttribute("content", content);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    origin,
  );

  // A link preview bot gets every tag inside the raw <head>.
  const raw = await (
    await page.request.get("/", {
      headers: { "User-Agent": "facebookexternalhit/1.1" },
    })
  ).text();
  const head = raw.slice(0, raw.indexOf("</head>"));
  expect(head).toContain(`<meta property="og:image" content="${image}"/>`);
  expect(head).toContain(`<meta property="og:url" content="${origin}"/>`);
  expect(head).toContain(`<meta name="twitter:image" content="${image}"/>`);
  expect(head).toContain(
    '<meta name="twitter:card" content="summary_large_image"/>',
  );
  expect(head).toContain(`<link rel="canonical" href="${origin}"/>`);

  const card = await page.request.get(image);
  expect(card.status()).toBe(200);
  expect(card.headers()["content-type"]).toBe("image/jpeg");
  const bytes = await card.body();
  expect(bytes.length).toBeLessThan(500 * 1024);
  expect(jpegSize(bytes)).toEqual({ width: 1200, height: 630 });
});

// covers: AC-7
test("every page but / is noindex", async ({ page }) => {
  for (const path of ["/book", "/reservations", "/auth/error"]) {
    await page.goto(path);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
  }
  const admin = await page.request.get("/admin/testbed-types", {
    maxRedirects: 0,
  });
  expect(admin.headers()["x-robots-tag"]).toBe("noindex, nofollow");
});

// covers: AC-8, AC-9
test("robots.txt and the sitemap open only / to crawlers", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "").origin;
  const robots = await page.request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const rules = await robots.text();
  expect(rules).toContain("Allow: /\n");
  expect(rules).toContain("Disallow: /admin\n");
  expect(rules).toContain("Disallow: /api/\n");
  expect(rules).toContain(`Sitemap: ${origin}/sitemap.xml`);

  const sitemap = await page.request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect([...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])).toEqual([
    `${origin}/`,
  ]);

  for (const body of [rules, xml]) {
    expect(body).not.toContain(ADMIN_ENTRY);
    expect(body).not.toContain("/auth/admin-entry");
  }
});

async function expectFooter(page: Page) {
  const footer = page.locator("main + footer");
  await expect(footer).toHaveCount(1);
  await expect(footer).toContainText("Nile Hands-On Labs · nilesecure.com");
  await expect(footer).toContainText(
    `Copyright © ${new Date().getUTCFullYear()} Nile. All rights reserved.`,
  );
  const link = footer.getByRole("link", { name: "nilesecure.com" });
  await expect(link).toHaveAttribute("href", "https://www.nilesecure.com");
  await expect(link).toHaveCSS("text-decoration-line", "underline");
}

// covers: AC-5
test("every learner page ends with the Nile footer", async ({ page }) => {
  for (const path of ["/", "/book", "/auth/error", "/reservations"]) {
    await page.goto(path);
    await expectFooter(page);
  }
  test.skip(!haveSecrets, "hol-test passwords are not on this machine");
  await signIn(page, "/reservations", learner);
  await expect(accountMenu(page)).toBeVisible();
  await expectFooter(page);
});

// covers: AC-5
test("admin pages and the admin entry have no footer", async ({
  adminPage: page,
  browser,
}) => {
  test.skip(!haveSecrets, "hol-test passwords are not on this machine");
  await page.goto("/admin/testbed-types");
  await expect(
    page.getByRole("heading", { name: "Testbed Types" }),
  ).toBeVisible();
  await expect(page.locator("footer")).toHaveCount(0);

  const anonymous = await browser.newPage();
  await anonymous.goto(ADMIN_ENTRY);
  await expect(
    anonymous.getByRole("heading", { name: "Sign in" }),
  ).toBeVisible();
  await expect(anonymous.locator("footer")).toHaveCount(0);
  await anonymous.close();
});
