import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// No serious or critical axe violation on the page, less `exclude`
// (selectors for third party content such as Turnstile).
export async function expectNoSeriousViolations(
  page: Page,
  exclude: readonly string[] = [],
) {
  const results = await exclude
    .reduce((axe, sel) => axe.exclude(sel), new AxeBuilder({ page }))
    .withTags(TAGS)
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  expect(serious).toEqual([]);
}
