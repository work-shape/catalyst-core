import { reviewer, signIn } from "./inbox-fixtures";
import { shootEverywhere } from "./surface-shots";
import { expect, test } from "./test";

// The first Studio visit should offer the things a person makes. Its scope picker is an
// overlay: a following filter must never paint over it or intercept a scope choice.
test("Studio starts with agents and scope options stay clickable above following filters", async ({
  page
}) => {
  test.setTimeout(90_000);
  await signIn(page, reviewer);
  await page.evaluate(() => {
    // A browser from before the fix remembered Connections as Studio's destination.
    window.localStorage.setItem("vivd-catalyst:build-kind", "connections");
    window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
  });
  await page.reload();
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await expect(page).toHaveURL(/\/build\/agents$/u);
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  await page.goto("/build/data-stores");
  const scope = page.getByRole("button", { name: /^Scope: /u });
  for (let switchNumber = 0; switchNumber < 2; switchNumber += 1) {
    await scope.click();
    const personal = page.getByRole("option", { name: "Personal", exact: true });
    await expect(personal).toBeVisible();
    await expect
      .poll(() =>
        personal.evaluate((option) => {
          const box = option.getBoundingClientRect();
          return option.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          );
        })
      )
      .toBe(true);
    await personal.click();
    await expect(scope).toHaveAccessibleName("Scope: Personal");
    await expect(page.getByRole("option")).toHaveCount(0);
    await scope.click();
    await page.getByRole("option", { name: "Instance", exact: true }).click();
    await expect(scope).toHaveAccessibleName("Scope: Instance");
    await expect(page.getByRole("option")).toHaveCount(0);
  }

  await shootEverywhere(page, "accept-fix-4-scope", async () => {
    const picker = page.getByRole("button", { name: /^(?:Scope|Geltungsbereich|Wo): /u });
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(page.getByRole("option").first()).toBeVisible();
  });
});
