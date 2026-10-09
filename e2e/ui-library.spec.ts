import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type Locator, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

// The default theme's raised surface: in dark the fill carries the lift, so it differs from the page.
const darkPopover = "color-mix(in srgb, #efebe4 6%, #1c1a17)";

test("the UI library gallery opens for an administrator and for nobody else", async ({
  page,
  browser
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await expect(page.getByRole("heading", { name: "UI library", level: 1 })).toBeVisible();
  // It opens on the three sample pages, under the one base theme.
  await expect(page.locator("[data-gallery-sample]")).toHaveCount(3);
  for (const sample of ["build-list", "asset-page", "settings-form"]) {
    await expect(page.locator(`[data-gallery-sample="${sample}"] [data-gallery-mode]`)).toHaveCount(
      1
    );
  }
  await expect(page.getByRole("group", { name: "Theme" })).toHaveCount(0);
  await openSection(page, "Actions");
  await expect(page.locator("[data-gallery-entry]")).not.toHaveCount(0);

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInViaApi(memberPage, normalUser);
  await memberPage.goto("/ui-library");
  await expect(memberPage).not.toHaveURL(/ui-library/u);
  await expect(memberPage.locator("[data-ui-gallery]")).toHaveCount(0);
  await memberContext.close();
});

test("the gallery switches mode and language without touching the application", async ({
  page
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  const applicationMode = await page.locator("html").getAttribute("data-vivd-theme");

  await openSection(page, "Sample pages");
  await choose(page, "Mode", "Dark");
  // The gallery's own frame follows the chosen mode.
  expect(await token(page.locator("[data-ui-gallery]"), "--background")).toBe("#1c1a17");
  const buildList = page.locator('[data-gallery-sample="build-list"]');
  await buildList.getByRole("searchbox").fill("no such asset");
  await buildList.getByRole("button", { name: "Clear filters" }).click();
  await expect(buildList.getByRole("searchbox")).toHaveValue("");

  await openSection(page, "Foundations");
  await choose(page, "Mode", "Both");
  const light = page.locator('[data-gallery-mode="light"]');
  const dark = page.locator('[data-gallery-mode="dark"]');
  await expect(light).toBeVisible();
  await expect(dark).toBeVisible();
  expect(await token(light, "--background")).toBe("#fdfbf7");
  expect(await token(light, "--primary")).toBe("#b5573a");
  expect(await token(dark, "--background")).toBe("#1c1a17");
  expect(await token(dark, "--primary")).toBe("#d98c6c");

  // The group's own name changes with the language, so the choice is checked by its effect.
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "DE" }).click();
  await expect(page.getByRole("heading", { name: "UI-Bibliothek", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Modus" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Abschnitte der UI-Bibliothek" })
    .getByRole("button", { name: "Beispielseiten" })
    .click();
  await expect(page.locator('[data-gallery-sample="settings-form"]').first()).toContainText(
    "Sprache und Darstellung"
  );

  expect(await page.locator("html").getAttribute("data-vivd-theme")).toBe(applicationMode);
});

test("overlays in a dark root show that root's theme, also inside a dialog", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Overlays");
  await choose(page, "Mode", "Dark");
  const root = page.locator('[data-gallery-mode="dark"]');
  // The overlay container is the root's last child, so an overlay is inside the themed root.
  const overlays = root.locator(":scope > [data-catalyst-overlays]");
  await expect(overlays).toHaveCount(1);

  // Tooltip: the gallery holds one open.
  const tooltip = overlays.locator("[data-side]").filter({ hasText: "Copy the link" }).first();
  await expect(tooltip).toBeVisible();
  expect(await token(tooltip, "--popover")).toBe(darkPopover);

  // Hover card.
  await root.getByRole("button", { name: "Context" }).hover();
  const hoverCard = overlays.locator("[data-side]").filter({ hasText: "context window" });
  await expect(hoverCard).toBeVisible();
  expect(await token(hoverCard, "--popover")).toBe(darkPopover);
  expect(await backgroundOf(hoverCard)).not.toBe(await backgroundOf(root));
  await page.mouse.move(0, 0);

  // Dialog: native, in the top layer, with a container of its own for what opens inside it.
  await root.getByRole("button", { name: "Open dialog md" }).click();
  const dialog = root.getByRole("dialog", { name: "Delete agent" });
  await expect(dialog).toBeVisible();
  expect(await token(dialog, "--popover")).toBe(darkPopover);
  expect(await dialog.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("16px");

  // Opening focuses the close button, and that shows no tooltip.
  await expect(dialog.locator("[data-catalyst-overlays] [data-side]")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Copy the link" }).hover();
  const tooltipInDialog = dialog.locator("[data-catalyst-overlays] [data-side]");
  await expect(tooltipInDialog).toBeVisible();
  expect(await token(tooltipInDialog, "--popover")).toBe(darkPopover);

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("the tooltip the gallery holds open leaves the first Escape to a dialog", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Overlays");
  const root = page.locator("[data-gallery-mode]").first();
  const held = root
    .locator(":scope > [data-catalyst-overlays] [data-side]")
    .filter({ hasText: "Copy the link" });
  await expect(held).toBeVisible();

  await root.getByRole("button", { name: "Open dialog md" }).click();
  const dialog = root.getByRole("dialog", { name: "Delete agent" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("anchored overlays sit on the raised surface and answer the keyboard", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Overlays");
  await choose(page, "Mode", "Dark");
  const root = page.locator('[data-gallery-mode="dark"]');
  const overlays = root.locator(":scope > [data-catalyst-overlays]");
  const raised = {
    "background-color": await resolved(root, "background-color", "var(--popover)"),
    "box-shadow": await resolved(root, "box-shadow", "var(--shadow-overlay)"),
    "border-radius": "12px"
  };
  const expectRaised = async (panel: Locator) => {
    await expect(panel).toBeVisible();
    expect(await token(panel, "--popover")).toBe(darkPopover);
    for (const [property, value] of Object.entries(raised)) {
      expect(await computed(panel, property), property).toBe(value);
    }
  };

  // Popover: focus moves in, Escape and a click outside close it, focus returns to the trigger.
  const popoverTrigger = root.getByRole("button", { name: "Open popover md" });
  await popoverTrigger.click();
  const popover = overlays.getByRole("dialog");
  await expectRaised(popover);
  expect(await computed(popover, "width")).toBe("304px");
  await expect(popover.getByLabel("Filter by state")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(popoverTrigger).toBeFocused();
  await popoverTrigger.click();
  await expect(popover).toBeVisible();
  await root.getByRole("heading", { name: "Popover", level: 3 }).click();
  await expect(popover).toBeHidden();

  // Menu: arrow keys and Enter, a disabled item with its reason, the destructive item last.
  const menuEntry = root.locator('[data-gallery-entry="DropdownMenu"]');
  const menuTrigger = menuEntry.getByRole("button", { name: "More actions" });
  await menuTrigger.click();
  const menu = overlays.getByRole("menu");
  await expectRaised(menu);
  const runNow = menu.getByRole("menuitem", { name: "Run now" });
  for (const item of ["Edit", "Duplicate", "Copy link", "Run now"]) {
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: item })).toBeFocused();
  }
  await expect(runNow).toHaveAttribute("aria-disabled", "true");
  await expect(
    overlays.locator("[data-side]").filter({ hasText: "A run is still in progress." })
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // The plainly disabled item is skipped.
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeFocused();
  await expect(menu.getByRole("menuitem").last()).toHaveText("Delete");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  // A checkable item switches and the menu stays open.
  await menuEntry.getByRole("button", { name: "View" }).click();
  await expect(menu.getByText("State", { exact: true })).toBeVisible();
  const showArchived = menu.getByRole("menuitemcheckbox", { name: "Show archived" });
  await expect(showArchived).toHaveAttribute("aria-checked", "false");
  await showArchived.click();
  await expect(showArchived).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // Picker: groups, search in the caller's order, a disabled option, the create row last.
  const pickerEntry = root.locator('[data-gallery-entry="Picker"]');
  const pickerTrigger = pickerEntry.getByRole("button", { name: "Support assistant" });
  await pickerTrigger.click();
  const picker = overlays.getByRole("dialog");
  await expectRaised(picker);
  const search = picker.getByRole("combobox");
  await expect(search).toBeFocused();
  await expect(picker.getByText("This workspace")).toBeVisible();
  await expect(picker.getByText("Instance", { exact: true })).toBeVisible();
  const options = picker.getByRole("option");
  await expect(options).toHaveCount(5);
  await search.fill("ass");
  await expect(options).toHaveText([
    /^Support assistant/u,
    /^Research assistant/u,
    /^Payroll assistant/u,
    "Create new agent"
  ]);
  const payroll = picker.getByRole("option", { name: "Payroll assistant" });
  await expect(payroll).toHaveAttribute("aria-disabled", "true");
  await expect(payroll).toContainText("Needs a connection that is not set up");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  // The disabled option is skipped, so the next stop is the create row.
  await page.keyboard.press("ArrowDown");
  await expect(picker.getByRole("option", { name: "Create new agent" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  const createdTrigger = pickerEntry.getByRole("button", { name: "ass", exact: true });
  await expect(createdTrigger).toBeFocused();

  await createdTrigger.click();
  await search.fill("no such agent");
  await expect(picker.getByText("No results")).toBeVisible();
  await expect(options).toHaveText(["Create new agent"]);
  await search.fill("research");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(pickerEntry.getByRole("button", { name: "Research assistant" })).toBeFocused();

  // Several at once: the picker stays open and each choice shows its check.
  await pickerEntry.getByRole("button", { name: "Workspaces" }).click();
  await expect(picker.getByRole("combobox")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await expect(pickerEntry.getByRole("button", { name: "Workspaces" })).toContainText("2");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
});

test("a picker inside a dialog opens in the dialog and Escape closes the picker first", async ({
  page
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Overlays");
  await choose(page, "Mode", "Dark");
  const root = page.locator('[data-gallery-mode="dark"]');

  await root.getByRole("button", { name: "Picker in a dialog" }).click();
  const dialog = root.getByRole("dialog", { name: "Picker in a dialog" });
  await expect(dialog).toBeVisible();
  const trigger = dialog.getByRole("button", { name: "Support assistant" });
  await trigger.click();
  // The picker renders into the dialog's own container, so it is in the top layer with it.
  const picker = dialog.locator("[data-catalyst-overlays]").getByRole("dialog");
  await expect(picker).toBeVisible();
  await expect(root.locator(":scope > [data-catalyst-overlays]").getByRole("dialog")).toHaveCount(
    0
  );
  expect(await token(picker, "--popover")).toBe(darkPopover);
  await expect(picker.getByRole("combobox")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a confirmation names its object and holds both buttons while the action runs", async ({
  page
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Overlays");
  const root = page.locator("[data-gallery-mode]").first();
  const entry = root.locator('[data-gallery-entry="ConfirmDialog"]');

  await entry.getByRole("button", { name: "Delete agent" }).click();
  const dialog = root.getByRole("dialog", { name: "Delete Support assistant?" });
  await expect(dialog).toBeVisible();
  expect(await computed(dialog, "border-radius")).toBe("16px");
  expect(await computed(dialog, "box-shadow")).toBe(
    await resolved(root, "box-shadow", "var(--shadow-modal)")
  );
  expect(await computed(dialog, "background-color")).toBe(
    await resolved(root, "background-color", "var(--popover)")
  );
  const confirm = dialog.getByRole("button", { name: "Delete", exact: true });
  expect(await computed(confirm, "background-color")).toBe(
    await resolved(root, "background-color", "var(--destructive)")
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await entry.getByRole("button", { name: "Publish changes" }).click();
  const publish = root.getByRole("dialog", { name: "Publish Support assistant?" });
  expect(await computed(publish.getByRole("button", { name: "Publish" }), "background-color")).toBe(
    await resolved(root, "background-color", "var(--primary)")
  );
  await publish.getByRole("button", { name: "Publish" }).click();
  await expect(publish).toBeHidden();

  await entry.getByRole("button", { name: "While it runs" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(dialog.locator('button[aria-busy="true"]')).toBeDisabled();
});

test("form controls show the strong edge and a field wires its control", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Forms");
  await choose(page, "Mode", "Both");

  for (const mode of ["light", "dark"]) {
    const root = page.locator(`[data-gallery-mode="${mode}"]`);
    const strongEdge = await resolved(root, "color", "var(--input-strong)");
    const checkbox = root.locator('[data-gallery-entry="Checkbox"] [role="checkbox"]').first();
    const radio = root
      .locator('[data-gallery-entry="RadioGroup"] [role="radio"][aria-checked="false"]')
      .first();
    const offSwitch = root.locator('[data-gallery-entry="Switch"] [role="switch"]').first();
    for (const control of [checkbox, radio, offSwitch]) {
      expect(await computed(control, "border-top-color"), mode).toBe(strongEdge);
    }
    expect(await computed(offSwitch, "background-color"), mode).toBe(strongEdge);
    expect(await computed(checkbox, "border-radius")).toBe("4px");
    expect((await checkbox.boundingBox())?.height).toBe(16);
  }

  const root = page.locator('[data-gallery-mode="light"]');
  const field = root.locator('[data-gallery-entry="Field"]');
  const name = field.getByRole("textbox", { name: "Name" }).first();
  const role = field.getByRole("combobox", { name: "Role" });
  for (const control of [name, role]) {
    expect((await control.boundingBox())?.height).toBe(36);
    expect(await computed(control, "border-top-color")).toBe(
      await resolved(root, "color", "var(--input)")
    );
    expect(await computed(control, "box-shadow")).toBe("none");
  }
  await expect(field.getByText("Optional").first()).toBeVisible();

  // The label focuses its control; the hint describes it until an error takes its place.
  await field.locator("label").first().click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("required", "");
  await expect(name).toHaveAccessibleDescription(
    "Shown in the agent list and in every conversation."
  );
  await name.fill("ab");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("Enter a name with at least three characters.");
  await expect(field.getByRole("alert").first()).toHaveText(
    "Enter a name with at least three characters."
  );
  await name.fill("abc");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");

  // A switch row: the label beside the switch toggles it.
  const liveChanges = field.getByRole("switch", { name: "Live changes" });
  await field.getByText("Live changes", { exact: true }).click();
  await expect(liveChanges).toBeChecked();

  // Select all is indeterminate while only some rows are checked.
  const checkboxes = root.locator('[data-gallery-entry="Checkbox"]');
  const selectAll = checkboxes.getByRole("checkbox", { name: "Select all" });
  await expect(selectAll).toHaveAttribute("aria-checked", "mixed");
  await selectAll.click();
  await expect(selectAll).toHaveAttribute("aria-checked", "true");
  await expect(checkboxes.getByRole("checkbox", { name: "Invoice check" })).toBeChecked();
  await checkboxes.getByText("Invoice check").click();
  await expect(selectAll).toHaveAttribute("aria-checked", "mixed");

  // Radios: the arrow keys move the choice and skip the disabled option.
  const visibility = root.getByRole("radiogroup", { name: "Visibility" });
  const discoverable = visibility.getByRole("radio", { name: "Discoverable" });
  const privateOption = visibility.getByRole("radio", { name: "Private" });
  await expect(discoverable).toBeChecked();
  await discoverable.focus();
  // The choice follows the focus while the key is down, so the key is held for a moment.
  await page.keyboard.press("ArrowDown", { delay: 50 });
  await expect(privateOption).toBeChecked();
  await expect(privateOption).toBeFocused();
  await page.keyboard.press("ArrowDown", { delay: 50 });
  await expect(discoverable).toBeChecked();
  await expect(visibility.getByRole("radio", { name: "Archived" })).toBeDisabled();
});

test("status and feedback take their colours from the tone tokens in both modes", async ({
  page
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await openSection(page, "Status");
  await choose(page, "Mode", "Both");

  for (const mode of ["light", "dark"]) {
    const root = page.locator(`[data-gallery-mode="${mode}"]`);
    const color = (value: string) => resolved(root, "color", value);

    // A state badge is a tint or an outline; the accent badge is filled.
    const badges = root.locator('[data-gallery-entry="Badge"]');
    const published = badges.getByText("Published", { exact: true });
    expect(await computed(published.nth(0), "background-color"), mode).toBe(
      await color("var(--success-soft)")
    );
    expect(await computed(published.nth(1), "background-color"), mode).toBe("rgba(0, 0, 0, 0)");
    expect(await computed(published.nth(1), "border-top-color"), mode).toBe(
      await color("var(--success-border)")
    );
    expect(
      await computed(badges.getByText("New", { exact: true }).first(), "background-color")
    ).toBe(await color("var(--primary)"));

    // A person is round, a thing is a square with radius 8.
    const avatars = root.locator('[data-gallery-entry="Avatar"]');
    const person = avatars.locator('[data-kind="person"]').nth(2);
    expect((await person.boundingBox())?.width).toBe(32);
    expect(Number.parseFloat(await computed(person, "border-radius"))).toBeGreaterThanOrEqual(16);
    for (const kind of ["workspace", "agent", "app"]) {
      expect(await computed(avatars.locator(`[data-kind="${kind}"]`).nth(2), "border-radius")).toBe(
        "8px"
      );
    }
  }

  // A chip's remove button removes the chip.
  const chips = page.locator('[data-gallery-mode="light"] [data-gallery-entry="Chip"]');
  const remove = chips.getByRole("button", { name: "Remove" });
  await expect(remove).toHaveCount(3);
  await expect(remove.first()).toHaveAccessibleDescription("Marketing");
  await remove.first().click();
  await expect(remove).toHaveCount(2);

  await openSection(page, "Feedback");
  for (const mode of ["light", "dark"]) {
    const root = page.locator(`[data-gallery-mode="${mode}"]`);
    const color = (value: string) => resolved(root, "color", value);

    // Banner and FormNotice use the soft recipe.
    const banners = root.locator('[data-gallery-entry="Banner"]');
    for (const [tone, name] of [
      ["info", "info"],
      ["success", "success"],
      ["warning", "warning"],
      ["danger", "destructive"]
    ]) {
      const banner = banners.locator(`[data-tone="${tone}"]`).first();
      expect(await computed(banner, "background-color"), `${mode} ${tone}`).toBe(
        await color(`var(--${name}-soft)`)
      );
      expect(await computed(banner, "color"), `${mode} ${tone}`).toBe(
        await color(`var(--${name}-soft-foreground)`)
      );
      expect(await computed(banner, "border-top-color"), `${mode} ${tone}`).toBe(
        await color(`var(--${name}-border)`)
      );
    }
    const notices = root.locator('[data-gallery-entry="FormNotice"]');
    expect(await computed(notices.locator('[data-tone="success"]'), "color"), mode).toBe(
      await color("var(--success-soft-foreground)")
    );
    expect(await computed(notices.locator('[data-tone="error"]'), "color"), mode).toBe(
      await color("var(--destructive-soft-foreground)")
    );

    // An empty state has no frame.
    for (const emptyState of await root.locator("[data-layout]").all()) {
      expect(await computed(emptyState, "border-top-width")).toBe("0px");
      expect(await computed(emptyState, "box-shadow")).toBe("none");
      expect(await computed(emptyState, "background-color")).toBe("rgba(0, 0, 0, 0)");
    }
  }

  // Dismissing a banner removes it.
  const root = page.locator('[data-gallery-mode="light"]');
  const banners = root.locator('[data-gallery-entry="Banner"]');
  await expect(banners.getByText("2 steps need a connection")).toBeVisible();
  await banners.getByRole("button", { name: "Dismiss" }).click();
  await expect(banners.getByText("2 steps need a connection")).toHaveCount(0);
  await expect(root.locator('[data-gallery-entry="Skeleton"] [role="status"]').first()).toHaveText(
    "Loading"
  );
});

test("the base theme's measures hold in the gallery", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  const root = page.locator("[data-gallery-mode]").first();
  const style = (locator: Locator, property: string) =>
    locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

  // Fields are 36 px high, with radius 8 and no shadow at rest.
  await openSection(page, "Forms");
  const input = root.locator('[data-gallery-entry="Input"] input').first();
  const select = root.locator('[data-gallery-entry="Select"] select').first();
  expect((await input.boundingBox())?.height).toBe(36);
  expect((await select.boundingBox())?.height).toBe(36);
  expect(await style(input, "border-radius")).toBe("8px");
  expect(await style(input, "box-shadow")).toBe("none");

  // Focus is one 2 px line: in place of the border on a field, 2 px outside a button.
  await input.focus();
  expect(await style(input, "outline-width")).toBe("2px");
  expect(await style(input, "outline-style")).toBe("solid");
  expect(await style(input, "outline-offset")).toBe("-2px");

  // A card has radius 12 and no shadow.
  await openSection(page, "Page structure");
  const card = root.locator('[data-gallery-entry="Card"] [data-padding]').first();
  expect(await style(card, "border-radius")).toBe("12px");
  expect(await style(card, "box-shadow")).toBe("none");

  await openSection(page, "Actions");
  const button = root.locator('[data-gallery-entry="Button"] button').first();
  expect((await button.boundingBox())?.height).toBe(36);
  // A button is a pill with a hairline and the control edge; a ghost button stays flat.
  expect(Number.parseFloat(await style(button, "border-radius"))).toBeGreaterThanOrEqual(18);
  for (const name of ["Save", "Cancel"]) {
    const filled = root
      .locator('[data-gallery-entry="Button"]')
      .getByRole("button", { name, exact: true })
      .first();
    expect(await style(filled, "border-top-width")).toBe("1px");
    expect(await style(filled, "box-shadow")).not.toBe("none");
  }
  const ghost = root.locator('[data-gallery-entry="IconButton"] button').first();
  expect(await style(ghost, "box-shadow")).toBe("none");
  expect(await style(ghost, "background-color")).toBe("rgba(0, 0, 0, 0)");
  await button.focus();
  await page.keyboard.press("Tab");
  const focusedButton = root.locator('[data-gallery-entry="Button"] button:focus-visible');
  await expect(focusedButton).toHaveCount(1);
  expect(await style(focusedButton, "outline-width")).toBe("2px");
  expect(await style(focusedButton, "outline-offset")).toBe("2px");

  // Icon stroke: 1.5 at 16 and 20 px, 2 at 12 px.
  await openSection(page, "Foundations");
  const icons = root.locator('[data-gallery-entry="icons"] svg');
  expect(await style(icons.nth(0), "stroke-width")).toBe("2px");
  expect(await style(icons.nth(1), "stroke-width")).toBe("1.5px");
  expect(await style(icons.nth(3), "stroke-width")).toBe("1.5px");
});

/** Opens one section of the gallery by its entry in the section rail. */
async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.locator("[data-gallery-section] h2").first()).toHaveText(name);
}

async function choose(page: Page, group: string, option: string): Promise<void> {
  const button = page.getByRole("group", { name: group }).getByRole("button", { name: option });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

function token(locator: Locator, name: string): Promise<string> {
  return locator.evaluate(
    (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
    name
  );
}

function backgroundOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property
  );
}

/** What `value` computes to for `property` inside `scope`, so a token can be compared with a style. */
function resolved(scope: Locator, property: string, value: string): Promise<string> {
  return scope.evaluate(
    (element, [name, declared]) => {
      const probe = document.createElement("span");
      probe.style.setProperty(name, declared);
      element.append(probe);
      const result = getComputedStyle(probe).getPropertyValue(name);
      probe.remove();
      return result;
    },
    [property, value] as const
  );
}

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}
