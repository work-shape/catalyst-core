import { requestWithOrigin } from "./request-with-origin";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Holds no right to decide anything. */
const member = { email: "e2e-user@example.test", password: "e2e-user-password" };
/** May decide skill changes. */
const reviewer = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const skillName = "inbox_e2e_checklist";
const summary = "Add a checklist for reviewing travel expenses.";
const proposal = {
  skillName,
  summary,
  operations: [
    {
      type: "create_skill",
      name: skillName,
      title: "Travel expense checklist",
      description: "What to check on a travel expense claim.",
      content: "# Travel expenses\n\nCheck the receipt date against the trip."
    }
  ]
};

// The two tests share the instance: the first needs a member who has asked for nothing yet,
// and the second lets that member ask. Both fail without the Inbox: there was no such area.
test.describe.configure({ mode: "serial" });

test("a person who decides nothing and has asked for nothing has no Inbox row, and an empty Inbox by address", async ({
  page
}) => {
  await signIn(page, member);
  const rail = page.getByRole("navigation", { name: "Main navigation" });

  // One section is no list: the rail shows neither Chat nor Inbox.
  await expect(rail.getByRole("button", { name: /^Inbox/u })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);

  await page.goto("/inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(
    inbox.getByText("You have not requested anything that needs a decision.")
  ).toBeVisible();
  await expect(inbox.getByRole("tablist")).toHaveCount(0);

  await page.goto("/approvals");
  await expect(page).toHaveURL(/\/inbox$/u);
  await expect(inbox.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
});

test("a member's proposal waits in the reviewer's Inbox, is rejected there and comes back decided", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  // The member lets the agent propose a change.
  await signIn(page, member);
  await page
    .getByPlaceholder("Message")
    .fill(`/tool propose_skill_change ${JSON.stringify(proposal)}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("approval-request-card")).toContainText("Awaiting approval");

  // Their rail now has the Inbox, without a count: they have nothing to decide.
  const memberRail = page.getByRole("navigation", { name: "Main navigation" });
  const memberInboxRow = memberRail.getByRole("button", { name: "Inbox", exact: true });
  await expect(memberInboxRow).toBeVisible();
  await memberInboxRow.click();
  await expect(page).toHaveURL(/\/inbox$/u);
  const memberInbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(memberInbox.getByRole("tablist")).toHaveCount(0);
  const memberRow = memberInbox.getByTestId("inbox-row").filter({ hasText: summary });
  await expect(memberRow).toHaveCount(1);
  await expect(memberRow).toContainText("Awaiting approval");
  await expect(memberRow).toContainText("E2E User via Application Assistant");

  // The reviewer sees it counted in the rail.
  const reviewerContext = await browser.newContext({ baseURL });
  await pageErrors.watch(reviewerContext);
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, reviewer);
  const reviewerRail = reviewerPage.getByRole("navigation", { name: "Main navigation" });
  await reviewerRail.getByRole("button", { name: "Inbox, 1 to decide", exact: true }).click();
  const inbox = reviewerPage.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByRole("tab")).toHaveText(["To decide1", "My requests", "Decided"]);
  await expect(inbox.getByRole("tab", { name: /^To decide/u })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(inbox.getByText("Select a request to read it.")).toBeVisible();

  // Opening the row gives the item its address and shows it beside the list.
  const row = inbox.getByTestId("inbox-row").filter({ hasText: summary });
  await row.getByRole("button").click();
  await expect(reviewerPage).toHaveURL(/\/inbox\/[^/]+$/u);
  const itemAddress = new URL(reviewerPage.url()).pathname;
  const surface = inbox.getByRole("complementary", { name: "Skill change", exact: true });
  await expect(surface).toHaveAttribute("data-surface-mode", "beside");
  await expect(surface).toContainText("New skill: Travel expense checklist");
  await expect(surface.getByTestId("inbox-item")).toContainText(
    "Check the receipt date against the trip."
  );
  await expect(surface.getByTestId("inbox-item")).toContainText("Requested by E2E User");
  await expect(row.getByRole("button")).toHaveAttribute("aria-current", "true");
  // The origin conversation is the member's own.
  await expect(surface.getByRole("button", { name: "Open conversation" })).toHaveCount(0);

  // Rejecting needs no comment.
  await surface.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(surface.getByTestId("inbox-item")).toContainText("Rejected");
  await expect(surface.getByTestId("inbox-item")).toContainText("Decision by E2E Superadmin");
  await expect(reviewerRail.getByRole("button", { name: "Inbox", exact: true })).toBeVisible();
  await expect(inbox.getByText("Nothing to decide.")).toBeVisible();
  await inbox.getByRole("tab", { name: "Decided", exact: true }).click();
  await expect(inbox.getByTestId("inbox-row").filter({ hasText: summary })).toContainText(
    "Rejected"
  );

  // The address of the item opens the list that holds it now.
  await reviewerPage.goto(itemAddress);
  await expect(inbox.getByRole("tab", { name: "Decided", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(
    inbox.getByTestId("inbox-row").filter({ hasText: summary }).getByRole("button")
  ).toHaveAttribute("aria-current", "true");
  await expect(surface.getByTestId("inbox-item")).toContainText("Rejected");

  // On a narrow window the item covers the list and leads back to it.
  await reviewerPage.setViewportSize({ width: 390, height: 844 });
  await expect(surface).toHaveAttribute("data-surface-mode", "covering");
  await surface.getByRole("button", { name: "Show list", exact: true }).click();
  await expect(reviewerPage).toHaveURL(/\/inbox$/u);
  await expect(inbox.getByTestId("inbox-row").filter({ hasText: summary })).toBeVisible();
  await reviewerContext.close();

  // The member finds the outcome with who decided.
  await page.reload();
  await expect(memberRow).toContainText("Rejected");
  await memberRow.getByRole("button").click();
  const memberSurface = memberInbox.getByRole("complementary", {
    name: "Skill change",
    exact: true
  });
  await expect(memberSurface.getByTestId("inbox-item")).toContainText("Decision by E2E Superadmin");
  await expect(memberSurface.getByRole("button", { name: "Open conversation" })).toBeVisible();
  await expect(memberSurface.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);

  // An id that names nothing reads as the request that is gone.
  await page.goto("/inbox/apr_not_a_request");
  await expect(
    memberInbox.getByText("This proposal no longer exists or is not visible to you.")
  ).toBeVisible();
});

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Search", exact: true })
  ).toBeVisible();
}
