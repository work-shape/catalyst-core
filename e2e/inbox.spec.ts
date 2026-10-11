import { apiBaseUrl, reviewer, shoot, shotsDir, signIn } from "./inbox-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import type { Response } from "@playwright/test";
import { expect, test } from "./test";

/**
 * Holds no right to decide anything. The member of this file alone: its first test needs one
 * who has asked for nothing.
 */
const member = { email: "e2e-inbox@example.test", password: "e2e-inbox-password" };

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

  // The approver finds the call in the Inbox. The item says in a sentence who wants what and
  // shows the input the call is frozen with; where it came from is under the technical details.
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
  await expect(row).toContainText("Action to approve");
  await expect(row).toContainText(`E2E Inbox via Application Assistant · ${TOOL}`);
  await row.getByRole("button").click();
  await expect(approverPage).toHaveURL(/\/inbox\/[^/]+$/u);
  const call = approverPage.getByTestId("operation-call");
  await expect(call).toBeVisible();
  await expect(call.getByTestId("operation-call-headline")).toHaveText(
    "E2E Inbox wants to run a changing action."
  );
  await expect(call).toContainText(
    "If you approve, it runs once as E2E Inbox. If you decline, nothing runs."
  );
  // No rule can be named for this call, so the item gives no reason.
  await expect(call.getByTestId("operation-call-why")).toHaveCount(0);
  await expect(call.locator('[data-field="operation"]')).toContainText(TOOL);
  await expect(call.locator('[data-input-key="text"]')).toContainText(NOTE);
  const runId = await call.getAttribute("data-run-id");
  expect(runId).toBeTruthy();

  // While it waits, the run is on record as waiting and nothing ran.
  const waiting = await approverPage.request.get(`${apiBaseUrl}/api/v1/operations/runs/${runId}`);
  expect(waiting.ok()).toBe(true);
  expect(await waiting.json()).toMatchObject({ status: "pending_approval", operation: TOOL });

  await shoot(
    approverPage,
    "inbox-operation-call",
    async () => {
      await expect(approverPage.getByTestId("operation-call")).toBeVisible();
    },
    [1280, 1440, 390]
  );

  // The technical details are closed until asked for. They say where the call came from and
  // show everything it runs with, as it was frozen.
  await expect(call.getByTestId("operation-call-full-input")).toHaveCount(0);
  await call.getByTestId("operation-call-details-open").click();
  await expect(call.locator('[data-field="origin"]')).toContainText(
    "Agent, through agent Application Assistant"
  );
  await expect(call.getByTestId("operation-call-full-input")).toContainText(NOTE);
  // A reload closes the fold, so each shot opens it again.
  await shoot(approverPage, "inbox-operation-call-details", async () => {
    await approverPage.getByTestId("operation-call-details-open").click();
    await expect(approverPage.getByTestId("operation-call-full-input")).toBeVisible();
  });

  // In German the same item.
  await approverPage.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await approverPage.reload();
  await expect(call.getByTestId("operation-call-headline")).toHaveText(
    "E2E Inbox möchte eine ändernde Aktion ausführen."
  );
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
  await approverPage.getByTestId("operation-call-details-open").click();
  await expect(approverPage.locator('[data-field="origin"]')).toBeVisible();
  await expect(approverPage.getByTestId("operation-call-full-input")).toHaveCount(0);
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

const HELD_NAMESPACE = "e2ehold-";
const HELD_SKILL = `${HELD_NAMESPACE}parental-leave`;
const HELD_TITLE = "Parental leave: frequent questions";
const heldSkillUrl = `${apiBaseUrl}/api/v1/assets/skill/${HELD_SKILL}`;
const namespacesUrl = `${apiBaseUrl}/api/v1/instance/access/namespaces`;
const KEPT_PARAGRAPH = "Ask the HR team for the form.";
const OLD_PARAGRAPH = "Tell your team lead seven weeks before the leave starts.";
const NEW_PARAGRAPH = "Tell your team lead and the HR team eight weeks before the leave starts.";
const heldSkill = (paragraph: string) => ({
  name: HELD_SKILL,
  title: HELD_TITLE,
  description: "Answers the questions people ask before they take parental leave.",
  content: `# Parental leave\n\n${KEPT_PARAGRAPH}\n\n${paragraph}\n`
});
const grantsUrl = `${apiBaseUrl}/api/v1/instance/access/grants`;
/** The id of what an answer of the instance created. */
function idOf(body: unknown): string {
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("The answer names no id.");
  }
  return body.id;
}
/** The widths the item of a held skill is pictured at: a desk and a phone. */
const SKILL_SHOT_WIDTHS = [1440, 390];

// Fails without the skill view of a held save: the row named the operation `assets.put`, and
// the item showed the skill's definition as one escaped line under "Approving runs this call".
test("a held skill save reads in the Inbox as the skill it creates, then as the paragraph it changes", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  let writerId: string | undefined;
  let grantId: string | undefined;
  let withheldRequestId: string | undefined;
  test.setTimeout(shotsDir ? 240_000 : 90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, reviewer);
  const answerOf = (data: object) => requestWithOrigin(page, "put", heldSkillUrl, { data });
  const openRow = async (heading: string) => {
    await page.goto("/inbox");
    // Found without the region's name, which the pictures read in two languages.
    const row = page.getByTestId("inbox-row").filter({ hasText: HELD_TITLE });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(heading);
    await expect(row).toContainText(`E2E Superadmin · ${HELD_NAMESPACE}`);
    await shoot(
      page,
      `inbox-row-${heading.startsWith("New") ? "new-skill" : "skill-change"}`,
      () => expect(row).toBeVisible(),
      SKILL_SHOT_WIDTHS
    );
    await row.getByRole("button").click();
    await expect(page).toHaveURL(/\/inbox\/[^/]+$/u);
  };
  const call = page.getByTestId("operation-call");
  const headline = call.getByTestId("operation-call-headline");

  const registered = await requestWithOrigin(page, "post", namespacesUrl, {
    data: { prefix: HELD_NAMESPACE, displayName: "E2E held skills" }
  });
  expect(registered.ok()).toBe(true);
  try {
    // The instance holds a skill saved into this Namespace, the superadmin's own too.
    expect((await answerOf({ config: heldSkill(OLD_PARAGRAPH) })).status()).toBe(202);

    // A new skill: the row names it, and the item shows all of it with its line breaks.
    await openRow(`New skill: ${HELD_TITLE}`);
    await expect(headline).toHaveText(
      `E2E Superadmin wants to create the skill “${HELD_TITLE}” in the Namespace ${HELD_NAMESPACE}.`
    );
    await expect(call).toContainText(
      "If you approve, the skill is saved. If you decline, nothing changes."
    );
    await expect(call.getByTestId("operation-call-why")).toHaveText(
      "Needs a decision because this instance holds new and changed skills for approval."
    );
    const skill = call.getByTestId("operation-call-skill");
    await expect(skill).toContainText(KEPT_PARAGRAPH);
    await expect(skill).toContainText(OLD_PARAGRAPH);
    await expect(call).not.toContainText("\\n");
    // The operation's name is under the technical details, which are closed.
    await expect(call).not.toContainText("assets.put");
    await call.getByTestId("operation-call-details-open").click();
    await expect(call.locator('[data-field="operation"]')).toContainText("assets.put");
    await shoot(page, "inbox-new-skill", () => expect(headline).toBeVisible(), SKILL_SHOT_WIDTHS);

    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await expect(headline).toHaveText(
      `E2E Superadmin möchte die Fähigkeit „${HELD_TITLE}“ im Namespace ${HELD_NAMESPACE} anlegen.`
    );
    await page.evaluate(() => window.localStorage.removeItem("vivd-catalyst:locale"));
    await page.reload();

    // Approving saves the skill. A change of one paragraph is then held in the same way.
    const runId = await call.getAttribute("data-run-id");
    await page.locator('button[data-decision="approve"]').click();
    await expect
      .poll(async () => {
        const run = await page.request.get(`${apiBaseUrl}/api/v1/operations/runs/${runId}`);
        return (await run.json()).status;
      })
      .toBe("done");
    const change = await answerOf({
      config: heldSkill(NEW_PARAGRAPH),
      expectedRevision: await assetRevision(page, heldSkillUrl)
    });
    expect(change.status()).toBe(202);

    // A change: the item shows the paragraph before and after, and not the ones that stay.
    await openRow(`Skill change: ${HELD_TITLE}`);
    await expect(headline).toHaveText(
      `E2E Superadmin wants to change the skill “${HELD_TITLE}” in the Namespace ${HELD_NAMESPACE}.`
    );
    await expect(skill).toContainText(OLD_PARAGRAPH);
    await expect(skill).toContainText(NEW_PARAGRAPH);
    await expect(skill).not.toContainText(KEPT_PARAGRAPH);
    await expect(call).toContainText(
      "If you approve, the change is saved. If you decline, nothing changes."
    );
    await shoot(
      page,
      "inbox-skill-change",
      () => expect(headline).toBeVisible(),
      SKILL_SHOT_WIDTHS
    );

    // Declined, nothing changes: the skill keeps its paragraph.
    await page.locator('button[data-decision="reject"]').click();
    await expect(page.locator('button[data-decision="reject"]')).toHaveCount(0);
    const kept: unknown = await (await page.request.get(heldSkillUrl)).json();
    expect(JSON.stringify(kept)).toContain(OLD_PARAGRAPH);

    // A person who may write skills here and may not read them asks for the same change. Their
    // own request shows them the new text and says that nothing is compared: the paragraph
    // the skill has now is not theirs to read.
    const stamp = Date.now();
    const writer = {
      email: `e2e-held-writer-${stamp}@example.test`,
      password: `e2e-held-writer-${stamp}`
    };
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/instance/users`, {
      data: {
        displayLabel: "E2E Held Writer",
        email: writer.email,
        roles: ["user"],
        passwordSignIn: { password: writer.password }
      }
    });
    expect(created.ok()).toBe(true);
    writerId = idOf(await created.json());
    const granted = await requestWithOrigin(page, "post", grantsUrl, {
      data: {
        holderKind: "user",
        holderId: writerId,
        action: "skill.write",
        scopeKind: "namespace",
        namespace: HELD_NAMESPACE
      }
    });
    expect(granted.ok()).toBe(true);
    grantId = idOf(await granted.json());
    const writerContext = await browser.newContext({
      baseURL,
      viewport: { width: 1280, height: 900 }
    });
    await pageErrors.watch(writerContext);
    const writerPage = await writerContext.newPage();
    await signIn(writerPage, writer);
    expect((await writerPage.request.get(heldSkillUrl)).status()).toBe(403);
    const asked = await requestWithOrigin(writerPage, "put", heldSkillUrl, {
      data: {
        config: heldSkill(NEW_PARAGRAPH),
        expectedRevision: await assetRevision(page, heldSkillUrl)
      }
    });
    expect(asked.status()).toBe(202);
    const asking: unknown = await asked.json();
    withheldRequestId =
      typeof asking === "object" && asking !== null && "approvalRequestId" in asking
        ? String(asking.approvalRequestId)
        : undefined;
    expect(withheldRequestId).toBeTruthy();
    await writerPage.goto(`/inbox/${withheldRequestId}`);
    const withheld = writerPage.getByTestId("operation-call");
    await expect(withheld.getByTestId("operation-call-no-before")).toBeVisible();
    await expect(withheld).toContainText(NEW_PARAGRAPH);
    await expect(withheld).not.toContainText(OLD_PARAGRAPH);
    await shoot(
      writerPage,
      "inbox-skill-change-withheld",
      () => expect(writerPage.getByTestId("operation-call-no-before")).toBeVisible(),
      [1440]
    );
    await writerContext.close();
  } finally {
    if (withheldRequestId) {
      await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/approval-requests/${withheldRequestId}/decide`,
        { data: { decision: "reject" } }
      );
    }
    if (grantId) await requestWithOrigin(page, "delete", `${grantsUrl}/${grantId}`);
    if (writerId) {
      await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/instance/users/${writerId}`);
    }
    const found = await page.request.get(heldSkillUrl);
    if (found.ok()) {
      await requestWithOrigin(page, "post", `${heldSkillUrl}/delete`, {
        data: { expectedRevision: await assetRevision(page, heldSkillUrl) }
      });
    }
    await requestWithOrigin(page, "delete", `${namespacesUrl}/${HELD_NAMESPACE}`);
  }
});

/** A list answer the reader does not wait for: sooner than the library's loading layout appears. */
const INBOX_FAST_ANSWER_MS = 60;
/** A list answer long enough to notice. */
const INBOX_SLOW_ANSWER_MS = 700;
/** How long a tab is watched after the click: longer than the slow answer. */
const INBOX_WATCH_MS = 1_100;

test("a tab opened for the first time flashes no loading layout for a fast answer and shows it for a slow one", async ({
  page
}) => {
  await signIn(page, reviewer);
  let answerAfterMs = INBOX_FAST_ANSWER_MS;
  await page.route(
    (url) =>
      url.origin === new URL(apiBaseUrl).origin &&
      /^\/api\/v1\/approval-requests(?:\/mine)?$/u.test(url.pathname),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
      await route.continue();
    }
  );
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const openInbox = async () => {
    await page.goto("/inbox");
    await expect(inbox.getByRole("tab")).toHaveCount(3);
    await expect(inbox.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
  };
  // What each frame after the click shows: a loading layout the reader can see, and the
  // sentence of an empty list.
  const watch = () =>
    page.evaluate(
      (watchMs) =>
        new Promise<{ frames: number; loadingFrames: number; emptyTexts: string[] }>((resolve) => {
          const seen = { frames: 0, loadingFrames: 0, emptyTexts: new Set<string>() };
          const started = performance.now();
          const frame = () => {
            const area = document.querySelector('[data-testid="inbox-area"]');
            const loading = area?.querySelector('[role="tabpanel"] [role="status"]');
            seen.frames += 1;
            if (loading && Number.parseFloat(getComputedStyle(loading).opacity) > 0) {
              seen.loadingFrames += 1;
            }
            const empty = area?.querySelector('[data-testid="inbox-empty"]')?.textContent;
            if (empty) {
              seen.emptyTexts.add(empty);
            }
            if (performance.now() - started < watchMs) {
              requestAnimationFrame(frame);
            } else {
              resolve({ ...seen, emptyTexts: [...seen.emptyTexts] });
            }
          };
          requestAnimationFrame(frame);
        }),
      INBOX_WATCH_MS
    );
  const emptyTextNow = async () =>
    (await inbox.getByTestId("inbox-empty").count()) > 0
      ? [await inbox.getByTestId("inbox-empty").innerText()]
      : [];

  // A fast answer: the list is there before a loading layout would show, so none does, and
  // the sentence of another tab's empty list never stands in.
  await openInbox();
  for (const name of ["My requests", "Decided"]) {
    const before = await emptyTextNow();
    const frames = watch();
    await inbox.getByRole("tab", { name, exact: true }).click();
    const seen = await frames;
    await expect(inbox.getByRole("tab", { name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(seen.frames).toBeGreaterThan(10);
    expect(seen.loadingFrames).toBe(0);
    // Only the sentence that stood before the click and the one this tab ends with.
    const allowed = [...before, ...(await emptyTextNow())];
    expect(seen.emptyTexts.filter((text) => !allowed.includes(text))).toEqual([]);
  }

  // A slow answer: the library's loading layout shows while the reader waits.
  answerAfterMs = INBOX_SLOW_ANSWER_MS;
  await openInbox();
  const frames = watch();
  await inbox.getByRole("tab", { name: "My requests", exact: true }).click();
  expect((await frames).loadingFrames).toBeGreaterThan(0);
  await expect(inbox.getByRole("tabpanel").getByRole("status")).toHaveCount(0);
});
