import {
  apiBaseUrl,
  expectInboxFrameStill,
  idOf,
  reviewer,
  shoot,
  shotsDir,
  signIn,
  tabName
} from "./inbox-fixtures";
import { publishQuestionsLeadWithTheSentence } from "./publish-narrative-fixtures";
import { shareAsksForWhom } from "./share-1-fixtures";
import { allowOnInstance, approveMemberPublish } from "./publish-approval-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import type { Response } from "@playwright/test";
import { z } from "zod";
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
  // The third is the plus on the "Recent" heading, named as the row it repeats.
  await expect(reviewerEntries).toHaveCount(3);
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
  // The tabs that wait say how many: the list that waits as in the rail, and the reviewer's own
  // requests with none open without a number. The decided list carries no number.
  const toDecideTab = inbox.getByRole("tab", { name: /^To decide/u });
  const decidedTab = inbox.getByRole("tab", { name: /^Decided/u });
  await expect(toDecideTab).toHaveAccessibleName(tabName("To decide", 1));
  await expect(toDecideTab).toHaveAttribute("aria-selected", "true");
  await expect(inbox.getByRole("tab", { name: /^My requests/u })).toHaveAccessibleName(
    tabName("My requests", 0)
  );
  await expect(decidedTab).toHaveAccessibleName("Decided");
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
  // The decision leaves To decide without a reload, and Decided still carries no number.
  await expect(toDecideTab).toHaveAccessibleName(tabName("To decide", 0));
  await expect(decidedTab).toHaveAccessibleName("Decided");
  await decidedTab.click();
  await expect(inbox.getByTestId("inbox-row").filter({ hasText: summary })).toContainText(
    "Rejected"
  );

  // The address of the item opens the list that holds it now.
  await reviewerPage.goto(itemAddress);
  await expect(decidedTab).toHaveAttribute("aria-selected", "true");
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

  // The member asks for the change. The run pauses with the host's approval waiting card.
  await signIn(page, member);
  await page.getByPlaceholder("Message").fill(`/tool ${TOOL} ${JSON.stringify({ text: NOTE })}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.locator('[data-testid="tool-decision-card"][data-mode="approval"]')
  ).toBeVisible();
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

/** The suite's server holds a skill saved into a Shared Workspace of this name. */
const HELD_WORKSPACE = "E2E held skills";
/**
 * A name is the instance's once, whichever workspace holds it: each run takes its own, so a
 * skill a stopped run left in its workspace is no write this run makes against.
 */
const HELD_SKILL = `e2e-held-parental-leave-${Date.now()}`;
const HELD_TITLE = "Parental leave: frequent questions";
/** The skill's address. A read names the workspace in its query, a write in its body. */
const heldSkillBaseUrl = `${apiBaseUrl}/api/v1/assets/skill/${HELD_SKILL}`;
const workspacesUrl = `${apiBaseUrl}/api/v1/workspaces`;
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
/** The widths the item of a held skill is pictured at: a desk and a phone. */
const SKILL_SHOT_WIDTHS = [1440, 390];

// Fails without the skill view of a held save: the row named the operation `assets.put`, and
// the item showed the skill's definition as one escaped line under "Approving runs this call".
test("a held skill save reads in the Inbox as the skill it creates, then as the paragraph it changes", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  // The test writes a grant: it takes the turn of the specs that write grants or that assert
  // there is none, so none of them sees its rows.
  accessState: _accessState
}) => {
  let writerId: string | undefined;
  let grantId: string | undefined;
  let withheldRequestId: string | undefined;
  test.setTimeout(shotsDir ? 240_000 : 90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, reviewer);
  const created = await requestWithOrigin(page, "post", workspacesUrl, {
    data: { name: HELD_WORKSPACE }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idOf(await created.json());
  const heldSkillUrl = `${heldSkillBaseUrl}?workspaceId=${workspaceId}`;
  const answerOf = (data: object) =>
    requestWithOrigin(page, "put", heldSkillBaseUrl, { data: { ...data, workspaceId } });
  const openRow = async (heading: string) => {
    await page.goto("/inbox");
    await page.getByRole("tab", { name: /^To decide/u }).click();
    // Found without the region's name, which the pictures read in two languages.
    const row = page.getByTestId("inbox-row").filter({ hasText: HELD_TITLE });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(heading);
    await expect(row).toContainText("E2E Superadmin");
    // The heading names the skill by its title, not by its name.
    await expect(row).not.toContainText(HELD_SKILL);
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

  try {
    // The instance holds a skill saved into this workspace, the superadmin's own too. The
    // name is this run's, so the skill is new.
    expect(
      (
        await answerOf({
          config: heldSkill(OLD_PARAGRAPH),
          expectedRevision: null
        })
      ).status()
    ).toBe(202);

    // A new skill: the row names it, and the item shows all of it with its line breaks.
    await openRow(`New skill by E2E Superadmin: ${HELD_TITLE}`);
    await expect(headline).toHaveText(`E2E Superadmin wants to create the skill “${HELD_TITLE}”.`);
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
    await expect(headline).toHaveText(`E2E Superadmin möchte den Skill „${HELD_TITLE}“ anlegen.`);
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
    // ACCEPT-FIX-9 E4/E5: final state and the kind's preview survive without a reload.
    await expect(call.getByTestId("operation-call-outcome")).toHaveAttribute(
      "data-outcome",
      "done"
    );
    await expect(skill).toContainText(OLD_PARAGRAPH);
    const change = await answerOf({
      config: heldSkill(NEW_PARAGRAPH),
      expectedRevision: await assetRevision(page, heldSkillUrl)
    });
    expect(change.status()).toBe(202);

    // A change: the item shows the paragraph before and after, and not the ones that stay.
    await openRow(`Skill change by E2E Superadmin: ${HELD_TITLE}`);
    await expect(headline).toHaveText(`E2E Superadmin wants to change the skill “${HELD_TITLE}”.`);
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
    await expect(skill).toContainText(OLD_PARAGRAPH);
    await expect(skill).toContainText(NEW_PARAGRAPH);
    const kept: unknown = await (await page.request.get(heldSkillUrl)).json();
    expect(JSON.stringify(kept)).toContain(OLD_PARAGRAPH);

    // A person who may write skills here and may not read them asks for the same change. Their
    // own request names the skill and says why nothing else is shown: neither the paragraph
    // the skill has now nor the one proposed, not even under the technical details.
    const stamp = Date.now();
    const writer = {
      email: `e2e-held-writer-${stamp}@example.test`,
      password: `e2e-held-writer-${stamp}`
    };
    const user = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/instance/users`, {
      data: {
        displayLabel: "E2E Held Writer",
        email: writer.email,
        roles: ["user"],
        passwordSignIn: { password: writer.password }
      }
    });
    expect(user.ok()).toBe(true);
    writerId = idOf(await user.json());
    const granted = await requestWithOrigin(page, "post", grantsUrl, {
      data: {
        holderKind: "user",
        holderId: writerId,
        action: "skill.write",
        scopeKind: "asset",
        scopeId: idOf(await (await page.request.get(heldSkillUrl)).json())
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
    const asked = await requestWithOrigin(writerPage, "put", heldSkillBaseUrl, {
      data: {
        config: heldSkill(NEW_PARAGRAPH),
        expectedRevision: await assetRevision(page, heldSkillUrl),
        workspaceId
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
    await expect(withheld.getByTestId("operation-call-headline")).toContainText(HELD_TITLE);
    await expect(withheld).not.toContainText(NEW_PARAGRAPH);
    await expect(withheld).not.toContainText(OLD_PARAGRAPH);
    await withheld.getByTestId("operation-call-details-open").click();
    await expect(withheld.getByTestId("operation-call-technical")).toBeVisible();
    await expect(withheld).not.toContainText(NEW_PARAGRAPH);
    await expect(withheld.getByTestId("operation-call-full-input")).toHaveCount(0);
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
    // The skill goes with the workspace that owns it.
    await requestWithOrigin(page, "delete", `${workspacesUrl}/${workspaceId}`, {
      data: { confirmName: HELD_WORKSPACE }
    });
  }
});

// Fails without the one frame: the reading side stood only beside a list with rows, so the
// tabs moved sideways from an empty tab to a full one, and the header's band covered the title.
test("the title and the tabs stand still from a tab with rows to an empty one", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  const frameSummary = "Add a checklist for reviewing parking receipts.";
  await signIn(page, member);
  await page.getByPlaceholder("Message").fill(
    `/tool propose_skill_change ${JSON.stringify({
      ...proposal,
      skillName: "inbox_e2e_parking",
      summary: frameSummary,
      operations: [
        {
          ...proposal.operations[0],
          name: "inbox_e2e_parking",
          title: "Parking receipt checklist"
        }
      ]
    })}`
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("approval-request-card")).toContainText("Awaiting approval");

  const reviewerContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(reviewerContext);
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, reviewer);
  // The reviewer's own list is empty here, whatever another test let the reviewer ask for.
  await reviewerPage.route(
    (url) =>
      url.origin === new URL(apiBaseUrl).origin &&
      url.pathname === "/api/v1/approval-requests/mine",
    (route) => route.fulfill({ json: { items: [] } })
  );
  let requestId: string | null = null;
  try {
    await reviewerPage.goto("/inbox");
    const inbox = reviewerPage.getByRole("region", { name: "Inbox", exact: true });
    const row = inbox.getByTestId("inbox-row").filter({ hasText: frameSummary });
    await expect(row).toHaveCount(1);
    requestId = await row.getAttribute("data-item-id");

    // Wide: the reading side stands beside every tab, and no band lies over the title.
    await expect(inbox.getByText("Select a request to read it.")).toBeVisible();
    await expectInboxFrameStill(inbox, row);
    await expect(reviewerPage.locator("header[data-beside-surface]")).toHaveCount(0);

    // A phone has the list alone, in the same place on every tab.
    await reviewerPage.setViewportSize({ width: 390, height: 844 });
    await expect(inbox.getByText("Select a request to read it.")).toHaveCount(0);
    await expectInboxFrameStill(inbox, row);
  } finally {
    if (requestId) {
      await requestWithOrigin(
        reviewerPage,
        "post",
        `${apiBaseUrl}/api/v1/approval-requests/${requestId}/decide`,
        { data: { decision: "reject" } }
      );
    }
    await reviewerContext.close();
  }
});

// GR-PUB-1. Fails without the shipped guardrail: a member's Publish was live at once.
test("a member's publish of an App waits in the Inbox with its review, and an admin's approval makes it live", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  accessState: _accessState
}, testInfo) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  await signIn(page, reviewer);
  await approveMemberPublish({ page, browser, baseURL, pageErrors }, testInfo.retry);
});

// A Workflow the instance owns is published without a workspace. Fails without the reader's own
// workspace as its place: the item named the Workflow and led nowhere.
test("a member's held publish of an instance Workflow leads the reviewer to the Workflow", async ({
  page,
  browser,
  accessState: _accessState
}) => {
  test.setTimeout(90_000);
  const send = async (on: typeof page, method: "post" | "put", path: string, data?: unknown) => {
    const response = await requestWithOrigin(on, method, `${apiBaseUrl}${path}`, { data });
    expect(response.ok(), await response.text()).toBe(true);
    const body: unknown = await response.json();
    return body;
  };
  await signIn(page, reviewer);
  const personal = idOf(await send(page, "post", "/api/v1/workspaces/personal"));
  const name = `inbox-workflow-${Date.now()}`;
  await send(page, "post", "/api/v1/instance/service-principals", {
    name,
    displayLabel: name,
    description: "Runs the Inbox review Workflow"
  });
  await send(page, "put", `/api/v1/assets/workflow/${name}`, {
    expectedRevision: null,
    config: {
      name,
      manifest: {
        id: name,
        name: "Inbox review Workflow",
        description: "Waits for its publish to be approved",
        runAs: name,
        inputs: { type: "object", additionalProperties: false },
        outputs: {
          type: "object",
          properties: { done: { type: "integer" } },
          required: ["done"]
        },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
        ]
      }
    }
  });
  const context = await browser.newContext();
  const undo = await allowOnInstance("e2e-publish-member@example.test", [
    "workflow.read",
    "workflow.write",
    "workflow.publish"
  ]);
  try {
    const memberPage = await context.newPage();
    await send(memberPage, "post", "/api/auth/sign-in/email", {
      email: "e2e-publish-member@example.test",
      password: "e2e-publish-member-password",
      rememberMe: true
    });
    const held = z
      .object({ status: z.literal("pending_approval"), approvalRequestId: z.string() })
      .parse(
        await send(memberPage, "post", `/api/v1/assets/workflow/${name}/publish`, { revision: 1 })
      );
    await page.goto(`/inbox/${held.approvalRequestId}`);
    await expect(page.getByTestId("publish-review")).toBeVisible();
    const link = page.getByTestId("inbox-item-place");
    await expect(link).toHaveText("Open the Workflow");
    await expect(link).toHaveAttribute("href", `/w/${personal}/workflows/${name}`);
    await link.click();
    await expect(
      page.getByRole("heading", { name: "Inbox review Workflow", exact: true })
    ).toBeVisible();
  } finally {
    await undo();
    await context.close();
  }
});

test(
  "PUBQ-1: every publish question leads with the plain sentence in the reader's language, the lists behind Details",
  publishQuestionsLeadWithTheSentence
);

test(
  "SHARE-1: the Publish dialog asks “For whom?” first, the Inbox names the choice, and the save line shares",
  shareAsksForWhom
);
