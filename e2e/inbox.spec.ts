import { shootSurface as shoot } from "./surface-shots";
import { apiBaseUrl, reviewer, shotsDir, signIn } from "./inbox-fixtures";
import { approveMemberPublish } from "./publish-approval-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import type { Response } from "@playwright/test";
import { expect, test } from "./test";
import { requestAnswered } from "./allowed-page-errors";
import { randomUUID } from "node:crypto";
import {
  asker,
  DESKTOP,
  expectOwner,
  memberPage,
  PHONE,
  pickerSetup,
  shoot as shootShare,
  skillPicker
} from "./share-move-fixtures";

// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "request-that-is-gone",
        reason:
          "Chromium's own log line: the test opens the address of an Inbox item that does not " +
          "exist, the instance answers 404 and the page says so, which it asserts.",
        matches: requestAnswered(404),
        path: /^\/api\/v1\/approval-requests\/apr_not_a_request$/u,
        tests: [
          "a member's proposal waits in the reviewer's Inbox, is rejected there and comes back decided"
        ]
      },
      {
        name: "decision-that-came-too-late",
        reason:
          "Chromium's own log line: the test decides a request the instance has already decided, " +
          "the instance answers 409 and the page says who decided, which it asserts.",
        matches: requestAnswered(409),
        path: /^\/api\/v1\/approval-requests\/[^/]+\/decide$/u,
        tests: ["a decision on a request that was decided meanwhile is refused in a sentence"]
      }
    ]
  }
});

/**
 * Holds no right to decide anything. The member of this file alone: its first test needs one
 * who has asked for nothing.
 */
const member = { email: "e2e-inbox@example.test", password: "e2e-inbox-password" };

// These journeys share their member's requests and decisions in one instance.
test.describe.configure({ mode: "serial", retries: 0 });

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

  // The member has no Operations page: it needs the right to see the System pages.
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

for (const viewport of [DESKTOP, PHONE]) {
  for (const decision of ["approve", "reject"] as const) {
    test(`a picker share request is ${decision === "approve" ? "accepted" : "declined"} in the Inbox and the requester sees the result at ${viewport.width}px`, async ({
      page,
      browser,
      baseURL,
      pageErrors,
      instanceAgentsChange: _instanceAgentsChange
    }) => {
      test.setTimeout(120_000);
      await signIn(page, reviewer);
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
      const requester = await memberPage(browser, baseURL, pageErrors, asker, viewport);
      const fixture = await pickerSetup(
        page,
        requester,
        randomUUID().replaceAll("-", "").slice(0, 8)
      );
      // The seed lets the requester read skills for everyone, but only change their own.
      // The dialog's request path proves that they cannot perform this move themselves.
      try {
        const greyed = await skillPicker(requester, fixture.agent, fixture.name, fixture.title);
        await expect(greyed).toHaveAttribute("data-picker-action", "");
        await expect(greyed).toContainText("Für alle teilen…");
        await greyed.click();
        const dialog = requester.getByRole("dialog", { name: `„${fixture.title}“ teilen` });
        await expect(dialog.locator("[data-share-users]")).toHaveText(
          "Alle, denen es angeboten wird"
        );
        await expect(dialog.locator("[data-share-request]")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Teilen", exact: true })).toHaveCount(0);
        await dialog.getByRole("button", { name: "Anfrage senden" }).click();
        await expect(dialog.locator("[data-share-requested]")).toBeVisible();
        await dialog.getByRole("button", { name: "Schließen", exact: true }).last().click();
        await expectOwner(requester, "skill", fixture.name, fixture.personal);

        // The request is visible to its sender, who cannot decide it.
        await requester.goto("/inbox");
        const ownRow = requester.getByTestId("inbox-row").filter({ hasText: fixture.title });
        await expect(ownRow).toBeVisible();
        // A person without decision rights has only their own list, with no tab chooser.
        await expect(requester.getByRole("tab")).toHaveCount(0);
        await ownRow.getByRole("button").first().click();
        const requestUrl = requester.url();
        await expect(
          requester.getByTestId("inbox-item").locator('[data-status="pending"]')
        ).toHaveText("Wartet auf Freigabe");
        await expect(requester.getByRole("button", { name: "Annehmen", exact: true })).toHaveCount(
          0
        );
        await expect(requester.getByRole("button", { name: "Ablehnen", exact: true })).toHaveCount(
          0
        );

        await page.goto("/inbox");
        const row = page.getByTestId("inbox-row").filter({ hasText: fixture.title });
        await expect(row).toHaveCount(1);
        await row.getByRole("button").first().click();
        await expect(page).toHaveURL(requestUrl);
        const item = page.getByTestId("inbox-item");
        await expect(item).toContainText(
          `E2E Zz Move Asker möchte „${fixture.title}“ für alle teilen`
        );
        await expect(item.locator("[data-share-users]")).toHaveText(
          "Alle, denen es angeboten wird"
        );
        await expect(item.locator("[data-share-moves]")).toContainText(fixture.title);
        await shootShare(page, `inbox-${decision}-${viewport.width}`);
        await page
          .getByRole("button", {
            name: decision === "approve" ? "Annehmen" : "Ablehnen",
            exact: true
          })
          .click();
        await expect(item.getByTestId("inbox-item-outcome")).toContainText("E2E Superadmin");
        await expect(page.getByRole("button", { name: "Annehmen", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Ablehnen", exact: true })).toHaveCount(0);

        // The requester returns to their own request and reads the decision, then verifies its
        // practical effect in the same chooser and on the skill's own page.
        await requester.reload();
        const result = requester.getByTestId("inbox-item");
        await expect(result).toContainText(decision === "approve" ? "Übernommen" : "Abgelehnt");
        await expect(result.getByTestId("inbox-item-outcome")).toContainText("E2E Superadmin");
        await shootShare(requester, `requester-${decision}-${viewport.width}`);
        await expectOwner(
          requester,
          "skill",
          fixture.name,
          decision === "approve" ? undefined : fixture.personal
        );
        const option = await skillPicker(requester, fixture.agent, fixture.name, fixture.title);
        if (decision === "approve") {
          await expect(option).not.toHaveAttribute("data-picker-action");
          await expect(option).not.toContainText("Für alle teilen…");
          await option.click();
        } else {
          await expect(option).toHaveAttribute("data-picker-action", "");
          await expect(option).toContainText("Für alle teilen…");
        }
        await requester.keyboard.press("Escape");
        if (decision === "approve") {
          await expect(
            requester
              .getByRole("list", { name: "Skills", exact: true })
              .getByText(fixture.title, { exact: true })
          ).toBeVisible();
        }
        await requester.evaluate(
          (scope) => window.localStorage.setItem("vivd-catalyst:build-scope", scope),
          decision === "approve" ? "instance" : fixture.personal
        );
        await requester.goto(`/build/skills/${fixture.name}`);
        await expect(
          requester
            .locator("[data-asset-place]")
            .getByText(decision === "approve" ? "Alle" : "Nur ich", { exact: true })
        ).toBeVisible();
      } finally {
        await fixture.cleanup();
        await requester.context().close();
      }
    });
  }
}
