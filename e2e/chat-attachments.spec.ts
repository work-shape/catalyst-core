import type { Locator } from "@playwright/test";
import { signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// Where a file stands in a conversation, it carries the icon of its type: on the chip in the
// composer, on the label above the sent message and on its row in the Resources panel.

const member = { email: "e2e-user@example.test", password: "e2e-user-password" };

/** The files of the test with the icon each one gets. The instance takes these types. */
const files = [
  {
    name: "figures.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    icon: "spreadsheet"
  },
  { name: "letter.odt", mimeType: "application/vnd.oasis.opendocument.text", icon: "document" },
  {
    name: "slides.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    icon: "presentation"
  },
  { name: "notes.rtf", mimeType: "application/rtf", icon: "text" }
] as const;

/** The icon beside a file name: the one in the smallest box that holds the name and an icon. */
function iconBeside(area: Locator, filename: string): Locator {
  return area
    .locator(":scope *")
    .filter({ hasText: filename })
    .filter({ has: area.page().locator("[data-file-type]") })
    .last()
    .locator("[data-file-type]");
}

test("a file carries the icon of its type in the composer, above the message and in Resources", async ({
  page
}) => {
  await signIn(page, member);
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Add attachment" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(`${file.name} of the attachment test`)
    }))
  );

  // The chip says the type in words and the size once the upload stands.
  const composer = page.locator("form").filter({ has: page.getByPlaceholder("Message") });
  for (const file of files) {
    const icon = iconBeside(composer, file.name);
    await expect(icon).toHaveAttribute("data-file-type", file.icon);
    // The name beside it says the same, so the icon is not read out.
    await expect(icon).toHaveAttribute("aria-hidden", "true");
  }
  await expect(composer.getByText(/^Spreadsheet · \d+ B$/u)).toBeVisible();
  await expect(composer.getByText(/^Word document · \d+ B$/u)).toBeVisible();

  await page.getByPlaceholder("Message").fill("Four files of four types");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/^Local agent response:/u)).toBeVisible();

  const message = page.locator('[data-role="user"]').last();
  for (const file of files) {
    await expect(iconBeside(message, file.name)).toHaveAttribute("data-file-type", file.icon);
  }

  // The panel opens by itself with the first file of a conversation.
  const resources = page.getByRole("complementary", { name: "Resources" });
  for (const file of files) {
    await expect(iconBeside(resources, file.name)).toHaveAttribute("data-file-type", file.icon);
  }
});
