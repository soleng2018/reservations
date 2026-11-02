import { expect } from "@playwright/test";
import { z } from "zod";
import { test } from "./admin-session";
import { authentikGet, haveApi, haveSecrets, results } from "./authentik";

// Spec 0025 in the browser, against the real database and Authentik: the
// admin form refuses a one word name, and a rename also writes the first and
// last name that Nile reads. Like users.spec.ts it leaves one deactivated
// `dev-learner-…@nile-test.invalid` learner behind, by design.
test.skip(!haveSecrets || !haveApi, "hol-test passwords or API token missing");

const run = crypto.randomUUID().slice(0, 8);
const email = `dev-learner-${run}@nile-test.invalid`;

const attributesOfLearner = async () => {
  const found = await authentikGet(
    results(z.looseObject({ attributes: z.record(z.string(), z.unknown()) })),
    `/core/users/?username=${encodeURIComponent(email)}`,
  );
  expect(found.results).toHaveLength(1);
  return found.results[0]?.attributes ?? {};
};

// covers: spec 0025 AC-3, AC-6
test("the admin form needs a first and last name and keeps Nile's names in step", async ({
  adminPage: page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  const add = page.getByRole("dialog");
  await expect(add.getByText("First and last name")).toBeVisible();
  await add.getByLabel("Full name").fill(`Dev${run}`);
  await add.getByLabel("Company name").fill("Nile e2e");
  await add.getByLabel("Email address").fill(email);
  await add.getByRole("button", { name: "Save" }).click();
  await expect(add.getByText("Enter the first and last name.")).toBeVisible();
  const none = await authentikGet(
    results(z.looseObject({ pk: z.number() })),
    `/core/users/?username=${encodeURIComponent(email)}`,
  );
  expect(none.results).toHaveLength(0);

  // A full name saves.
  await add.getByLabel("Full name").fill(`Dev Learner${run}`);
  await add.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Added Dev Learner${run}.`)).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("searchbox", { name: "Search users" })
    .fill(`dev-learner-${run}`);
  await page
    .getByRole("row")
    .filter({ hasText: email })
    .getByRole("link", { name: `View Dev Learner${run}` })
    .click();

  // AC-6: a rename writes name, firstName and lastName, and keeps the tag.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog");
  await edit.getByLabel("Full name").fill("Renamed De Souza");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Updated Renamed De Souza.")).toBeVisible({
    timeout: 30_000,
  });
  expect(await attributesOfLearner()).toMatchObject({
    hol_learner: true,
    firstName: "Renamed",
    lastName: "Souza",
  });

  // AC-3: editing back to one word is refused and changes nothing.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await edit.getByLabel("Full name").fill("Renamed");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByText("Enter the first and last name.")).toBeVisible();
  expect(await attributesOfLearner()).toMatchObject({ lastName: "Souza" });
  await edit.getByRole("button", { name: "Cancel" }).click();

  // Leave the learner inactive, as users.spec.ts does.
  await page.getByRole("button", { name: "Deactivate user" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Deactivate", exact: true })
    .click();
  await expect(page.getByText("Deactivated Renamed De Souza.")).toBeVisible({
    timeout: 30_000,
  });
});
