import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { requestWithOrigin } from "./request-with-origin";
import type { Page, Response } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/**
 * Holds no right to decide anything. The member of this file alone: its first test needs one
 * who has asked for nothing.
 */
const member = { email: "e2e-inbox@example.test", password: "e2e-inbox-password" };
/** May decide skill changes and operation calls, and may view the audit log. */
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

// The tests share the instance: the first needs a member who has asked for nothing yet,
// and the second lets that member ask. Both fail without the Inbox: there was no such area.
test.describe.configure({ mode: "serial" });

test("a person who decides nothing and has asked for nothing has no Inbox row, and an empty Inbox by address", async ({
  page
}) => {
  await signIn(page, member);
  const rail = page.getByRole("navigation", { name: "Main navigation" });

  // The rail shows no Inbox to a person it holds nothing for, and never a Chat row.
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
  await expect(memberRow).toContainText("E2E Inbox via Application Assistant");

  // The reviewer sees it counted in the rail.
  const reviewerContext = await browser.newContext({ baseURL });
  await pageErrors.watch(reviewerContext);
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, reviewer);
  const reviewerRail = reviewerPage.getByRole("navigation", { name: "Main navigation" });
  // The Inbox row follows the one chat entry, and keeps its count in the collapsed strip.
  const reviewerEntries = reviewerRail.getByRole("button", {
    name: /^(New chat|Chat|Inbox, 1 to decide)$/u
  });
  await expect(reviewerEntries).toHaveCount(2);
  await expect(reviewerEntries.nth(0)).toHaveAccessibleName("New chat");
  await expect(reviewerEntries.nth(1)).toHaveAccessibleName("Inbox, 1 to decide");
  await expect(reviewerEntries.nth(1)).toContainText("1");
  await reviewerPage.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    reviewerRail.getByRole("button", { name: "Inbox, 1 to decide", exact: true })
  ).toBeVisible();
  await reviewerPage.getByRole("button", { name: "Expand sidebar" }).click();
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
  await expect(surface.getByTestId("inbox-item")).toContainText("Requested by E2E Inbox");
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

// Fails without the sentence and the kept comment: the item turned to "Rejected" under the
// Accept click, and what the reviewer had written was gone.
test("a decision on a request that was decided meanwhile is refused in a sentence", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  const lateSummary = "Add a checklist for reviewing mileage claims.";
  await signIn(page, member);
  await page.getByPlaceholder("Message").fill(
    `/tool propose_skill_change ${JSON.stringify({
      ...proposal,
      skillName: "inbox_e2e_mileage",
      summary: lateSummary,
      operations: [
        {
          ...proposal.operations[0],
          name: "inbox_e2e_mileage",
          title: "Mileage expense checklist"
        }
      ]
    })}`
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("approval-request-card")).toContainText("Awaiting approval");

  const reviewerContext = await browser.newContext({ baseURL });
  await pageErrors.watch(reviewerContext);
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, reviewer);
  await reviewerPage.goto("/inbox");
  const inbox = reviewerPage.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByTestId("inbox-row").filter({ hasText: lateSummary }).getByRole("button").click();
  await expect(reviewerPage).toHaveURL(/\/inbox\/[^/]+$/u);
  const itemId = new URL(reviewerPage.url()).pathname.split("/").at(-1) ?? "";
  const surface = inbox.getByRole("complementary", { name: "Skill change", exact: true });
  await surface.getByRole("textbox", { name: /^Comment/u }).fill("Fine, with the mileage rate.");

  // The same request is rejected from elsewhere while this page still shows it as waiting.
  const elsewhere = await requestWithOrigin(
    reviewerPage,
    "post",
    `${apiBaseUrl}/api/v1/approval-requests/${itemId}/decide`,
    { data: { decision: "reject" } }
  );
  expect(elsewhere.ok()).toBe(true);
  await expect(surface.getByTestId("inbox-item")).toContainText("Awaiting approval");

  await surface.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(surface.getByRole("alert")).toHaveText(
    "Your decision was not stored: E2E Superadmin has already decided this request."
  );
  await expect(surface.getByTestId("inbox-item")).toContainText("Rejected");
  await expect(surface.getByTestId("inbox-item-kept-comment")).toHaveValue(
    "Fine, with the mileage rate."
  );
  await expect(surface.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await reviewerContext.close();
});

// An agent's tool call that an admin set to approval, from the request in a conversation to
// the decision in the Inbox, the one execution, and the record under Instance > Operations.
// The suite's server holds the calls of `e2e.record_note` for an approval
// (clients/demo/src/e2e-server.ts). Fails without OP-1b: the tool ran unasked, nothing reached
// the Inbox and there was no Operations page.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

const TOOL = "e2e.record_note";
const NOTE = "Call the tenant about the meter reading";
const INPUT_MARKER = "meter reading";

test("an agent's tool call waits for approval, is approved in the Inbox, runs once and is on record", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(shotsDir ? 180_000 : 90_000);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The member asks the agent for the change. The tool does not run: the agent reads that
  // its call waits, and says so.
  await signIn(page, member);
  await page.getByPlaceholder("Message").fill(`/tool ${TOOL} ${JSON.stringify({ text: NOTE })}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("This call has NOT run").first()).toBeVisible();
  await expect(page.getByText(`"recorded"`)).toHaveCount(0);

  // The member has no Operations page: it needs the right to view the audit log.
  await page.goto("/settings");
  const memberPages = page.getByRole("navigation", { name: "Settings pages" });
  await expect(memberPages.getByRole("button").first()).toBeVisible();
  await expect(memberPages.getByRole("button", { name: "Operations", exact: true })).toHaveCount(0);

  // The approver finds the call in the Inbox, with who called, through which agent, and the
  // input the call is frozen with.
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 900 }
  });
  await pageErrors.watch(context);
  const approverPage = await context.newPage();
  await signIn(approverPage, reviewer);
  await approverPage.goto("/inbox");
  const inbox = approverPage.getByRole("region", { name: "Inbox", exact: true });
  const row = inbox.getByTestId("inbox-row").filter({ hasText: TOOL });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").click();
  await expect(approverPage).toHaveURL(/\/inbox\/[^/]+$/u);
  const call = approverPage.getByTestId("operation-call");
  await expect(call).toBeVisible();
  await expect(call.locator('[data-field="operation"]')).toContainText(TOOL);
  await expect(call.locator('[data-field="actor"]')).toContainText("E2E Inbox");
  await expect(call.locator('[data-field="origin"]')).toContainText(
    "Agent, through agent Application Assistant"
  );
  await expect(call.locator('[data-input-key="text"]')).toContainText(NOTE);
  await expect(call).toContainText("Approving runs this call once, as E2E Inbox.");
  const runId = await call.getAttribute("data-run-id");
  expect(runId).toBeTruthy();

  // While it waits, the run is on record as waiting and nothing ran.
  const waiting = await approverPage.request.get(`${apiBaseUrl}/api/v1/operations/runs/${runId}`);
  expect(waiting.ok()).toBe(true);
  expect(await waiting.json()).toMatchObject({ status: "pending_approval", operation: TOOL });

  await shoot(approverPage, "inbox-operation-call", async () => {
    await expect(approverPage.getByTestId("operation-call")).toBeVisible();
  });

  // The full view shows everything the call runs with, as it was frozen.
  await approverPage.getByTestId("operation-call-full-input-open").click();
  const fullInput = approverPage.getByRole("dialog", { name: "Full input" });
  await expect(fullInput.getByTestId("operation-call-full-input")).toContainText(NOTE);
  await approverPage.keyboard.press("Escape");
  await expect(fullInput).toHaveCount(0);
  // A reload closes the dialog, so each shot opens it again, and the reload below closes the
  // last one. No Escape here: with no dialog open it would close the request itself.
  await shoot(approverPage, "inbox-operation-call-full-input", async () => {
    await approverPage.getByTestId("operation-call-full-input-open").click();
    await expect(approverPage.getByTestId("operation-call-full-input")).toBeVisible();
  });

  // In German the same item.
  await approverPage.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await approverPage.reload();
  await expect(call).toContainText("Mit der Freigabe läuft dieser Aufruf einmal, als E2E Inbox.");
  await expect(approverPage.locator('button[data-decision="approve"]')).toHaveText("Freigeben");
  await expect(approverPage.locator('button[data-decision="reject"]')).toHaveText("Ablehnen");
  await approverPage.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
  await approverPage.reload();
  await expect(call).toBeVisible();

  // Approving records the decision at once; a job then executes the call.
  const [decided] = await Promise.all([
    approverPage.waitForResponse(
      (response) =>
        /\/api\/v1\/approval-requests\/[^/]+\/decide$/u.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST"
    ),
    approverPage.locator('button[data-decision="approve"]').click()
  ]);
  expect(decided.status()).toBe(200);
  await expect(approverPage.getByTestId("inbox-item")).toContainText("Decision by E2E Superadmin");
  await expect(approverPage.locator('button[data-decision="approve"]')).toHaveCount(0);
  // A second decision on the same request is refused and says why.
  const requestId = new URL(approverPage.url()).pathname.split("/").pop();
  const again = await requestWithOrigin(
    approverPage,
    "post",
    `${apiBaseUrl}/api/v1/approval-requests/${requestId}/decide`,
    { data: { decision: "approve" } }
  );
  expect(again.status()).toBe(409);

  // The item says what became of the call, and the input is gone from the request.
  await expect
    .poll(async () => {
      const run = await approverPage.request.get(`${apiBaseUrl}/api/v1/operations/runs/${runId}`);
      return (await run.json()).status;
    })
    .toBe("done");
  await approverPage.reload();
  const outcome = approverPage.getByTestId("operation-call-outcome");
  await expect(outcome).toHaveAttribute("data-outcome", "done");
  await expect(outcome).toContainText("Approved and executed.");
  await expect(approverPage.getByTestId("operation-call-input-removed")).toBeVisible();
  await expect(approverPage.getByTestId("operation-call-full-input-open")).toHaveCount(0);
  await shoot(approverPage, "inbox-operation-call-executed", async () => {
    await expect(outcome).toBeVisible();
  });

  // Instance > Operations lists the call: done, for the member, approved by the approver.
  const answers: Promise<string>[] = [];
  const collect = (response: Response): void => {
    if (/\/api\/v1\/operations\/runs/u.test(response.url())) answers.push(response.text());
  };
  approverPage.on("response", collect);
  await approverPage.goto("/settings/instance/operations");
  await expect(approverPage.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
  await expect(
    approverPage
      .getByRole("navigation", { name: "Settings pages" })
      .getByRole("button", { name: "Operations", exact: true })
  ).toBeVisible();
  const runRow = approverPage.locator(`tr[data-operation-run-id="${runId}"]`);
  // The page lists every call on the instance, a read of an asset included, the newest
  // first. The specs beside this one make many, so the call is found by its operation.
  const filters = approverPage.locator("[data-operation-run-filters]");
  const onlyTheTool = (label = "Operation, exact name") =>
    filters.getByRole("searchbox", { name: label }).fill(TOOL);
  await onlyTheTool();
  await expect(runRow).toHaveAttribute("data-status", "done");
  await expect(runRow).toContainText(TOOL);
  await expect(runRow).toContainText("E2E Inbox");
  await expect(runRow).toContainText("Done");

  // The filters narrow the list and say when nothing matches.
  await expect(runRow).toBeVisible();
  await expect(approverPage.locator("tr[data-operation-run-id]")).toHaveCount(1);
  await filters.getByRole("searchbox", { name: "Operation, exact name" }).fill("no.such_operation");
  await expect(approverPage.getByText("No call matches these filters.")).toBeVisible();
  await approverPage.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(filters.getByRole("searchbox", { name: "Operation, exact name" })).toHaveValue("");
  await expect(approverPage.locator("tr[data-operation-run-id]").first()).toBeVisible();
  await onlyTheTool();
  await expect(runRow).toBeVisible();

  // The detail names the decision and the correlation id, and carries no input or output.
  await runRow.getByRole("button", { name: `Show the call of ${TOOL}` }).click();
  const detail = approverPage.getByRole("dialog", { name: "Call of an operation" });
  await expect(detail.locator(`[data-operation-run-detail="${runId}"]`)).toBeVisible();
  await expect(detail.locator('[data-field="decision"]')).toContainText("Approved");
  await expect(detail.locator('[data-field="decision"]')).toContainText("E2E Superadmin");
  await expect(detail.locator('[data-field="correlationId"]')).not.toBeEmpty();
  await expect(detail.locator("a[data-approval-request-link]")).toHaveAttribute(
    "href",
    `/inbox/${requestId}`
  );
  await expect(detail).not.toContainText(INPUT_MARKER);
  await expect(detail).not.toContainText("recorded");
  approverPage.off("response", collect);
  for (const answer of await Promise.all(answers)) {
    expect(answer).not.toContain(INPUT_MARKER);
  }
  expect(answers.length).toBeGreaterThan(0);

  await approverPage.keyboard.press("Escape");
  await shoot(approverPage, "operations-detail", async () => {
    // Neither the filter nor the detail is part of the address: every reload sets them again.
    await onlyTheTool(
      (await approverPage.evaluate(() => window.localStorage.getItem("vivd-catalyst:locale"))) ===
        "de"
        ? "Operation, genauer Name"
        : undefined
    );
    await runRow.getByRole("button").first().click();
    await expect(approverPage.locator("[data-operation-run-detail]")).toBeVisible();
  });
  await approverPage.keyboard.press("Escape");
  await shoot(approverPage, "operations", async () => {
    await expect(approverPage.locator(`tr[data-operation-run-id="${runId}"]`)).toBeVisible();
  });

  // In German the same page.
  await approverPage.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await approverPage.reload();
  await expect(approverPage.getByRole("heading", { name: "Operationen", level: 1 })).toBeVisible();
  await onlyTheTool("Operation, genauer Name");
  await expect(runRow).toContainText("Erledigt");
  await runRow.getByRole("button", { name: `Aufruf von ${TOOL} anzeigen` }).click();
  const germanDetail = approverPage.getByRole("dialog", { name: "Aufruf einer Operation" });
  await expect(germanDetail.locator('[data-field="decision"]')).toContainText("Freigegeben");
  await approverPage.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
  await context.close();

  // The address is refused to the member too, not only hidden.
  const refused = await page.request.get(`${apiBaseUrl}/api/v1/operations/runs`);
  expect(refused.status()).toBe(403);
});

/** The same view in both languages and both themes, 1280 wide. */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const locale of ["en", "de"] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        ([localeValue, themeValue]) => {
          window.localStorage.setItem("vivd-catalyst:locale", localeValue);
          window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        },
        [locale, theme] as const
      );
      await page.reload();
      await ready();
      await page.screenshot({ path: join(shotsDir, `${name}-${theme}-${locale}-1280.png`) });
    }
  }
  await page.evaluate(() => {
    window.localStorage.removeItem("vivd-catalyst:locale");
    window.localStorage.removeItem("vivd-catalyst:theme");
  });
  await page.reload();
  await ready();
}

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
