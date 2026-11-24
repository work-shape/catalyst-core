// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import { required } from "./support/assertions";
import { WorkspaceMembersPage } from "./support/chat-ui";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  sharedWorkspace,
  waitForText
} from "./chat-ui-settings-fixtures";

// Workspace > Members against an instance that answers each list and change as a test says:
// what the page says when a list cannot be read, and where a refused change is said.

const workspace = sharedWorkspace();
const membersPath = apiOperations["workspaces.members.list"].buildPath({
  params: { collaborationWorkspaceId: workspace.id }
});
const requestsPath = apiOperations["workspaces.access_requests.list"].buildPath({
  params: { collaborationWorkspaceId: workspace.id }
});
const approvePath = apiOperations["workspaces.access_requests.approve"].buildPath({
  params: { collaborationWorkspaceId: workspace.id, userId: "user_9" }
});
const member = { userId: "user_1", displayLabel: "Felix Pahlke", email: null, role: "owner" };
const requester = {
  userId: "user_9",
  displayLabel: "Jonas Weber",
  email: "jonas@example.com",
  createdAt: "2026-08-20T09:30:00.000Z"
};
const refused = () =>
  Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
const failed = () =>
  Response.json({ error: { code: "INTERNAL", message: "Boom" } }, { status: 500 });

/** Mounts the page; `answers` maps a path to its answer, and every request is counted. */
async function mountMembers(
  answers: Record<string, () => Response>
): Promise<{ container: HTMLElement; calls: string[]; unmount(): Promise<void> }> {
  const calls: string[] = [];
  const answer: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    return (answers[path] ?? (() => Response.json({ items: [] })))();
  };
  const mounted = await mountPage(
    {
      ...settingsPageContext(
        createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: answer }),
        settingsUser({ instanceAdminName: "Mara" })
      ),
      workspace
    },
    "en",
    createElement(WorkspaceMembersPage)
  );
  return { ...mounted, calls };
}

/** The banner that says `said`, beside its retry where it offers one. */
function bannerSaying(container: HTMLElement, said: string): HTMLElement {
  return required(
    [...container.querySelectorAll<HTMLElement>("[data-tone]")].find((banner) =>
      banner.textContent?.startsWith(said)
    )
  );
}

function buttonNamed(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label
  );
}

describe("Workspace > Members, when a list cannot be read", () => {
  it("a refused list names whom to ask, as information without a retry", async () => {
    const mounted = await mountMembers({
      [membersPath]: () => Response.json({ items: [member] }),
      [requestsPath]: refused
    });
    try {
      await waitForText(mounted.container, "for example Mara.");
      expect(bannerSaying(mounted.container, "You").getAttribute("data-tone")).toBe("info");
      expect(buttonNamed(mounted.container, "Try again")).toBeUndefined();
    } finally {
      await mounted.unmount();
    }
  });

  it.each([
    { list: "members", path: membersPath, said: "Members could not be loaded." },
    { list: "requests", path: requestsPath, said: "Access requests could not be loaded." }
  ])("a failed $list list is an error with a retry that asks again", async ({ path, said }) => {
    const mounted = await mountMembers({
      [membersPath]: () => Response.json({ items: [member] }),
      [path]: failed
    });
    try {
      await waitForText(mounted.container, said);
      const banner = bannerSaying(mounted.container, said);
      expect(banner.getAttribute("data-tone")).toBe("danger");
      expect(banner.textContent).not.toContain("Mara");
      const asked = mounted.calls.filter((call) => call === `GET ${path}`).length;
      await act(async () => {
        required(buttonNamed(mounted.container, "Try again")).click();
      });
      await expect
        .poll(() => mounted.calls.filter((call) => call === `GET ${path}`).length)
        .toBe(asked + 1);
    } finally {
      await mounted.unmount();
    }
  });
});

describe("Workspace > Members, when a change is refused", () => {
  // Round 2: the refusal of Approve stood at the top of the page, two sections away, and said
  // only "You are not allowed to do this in this workspace."
  it("a refused Approve is said in Requests, naming whom to ask", async () => {
    const mounted = await mountMembers({
      [membersPath]: () => Response.json({ items: [member] }),
      [requestsPath]: () => Response.json({ items: [requester] }),
      [approvePath]: refused
    });
    try {
      await waitForText(mounted.container, "Jonas Weber");
      await act(async () => {
        required(buttonNamed(mounted.container, "Approve")).click();
      });
      const said = "You can't approve requests in this workspace.";
      await waitForText(mounted.container, said);
      const banner = bannerSaying(mounted.container, said);
      expect(banner.textContent).toContain("Mara");
      expect(banner.getAttribute("data-tone")).toBe("info");
      const section = required(banner.closest("section"));
      expect(
        section.querySelector('[data-testid="collaboration-workspace-request-row"]')
      ).not.toBeNull();
      const members = required(
        mounted.container.querySelector('[data-testid="collaboration-workspace-members"]')
      );
      expect(members.contains(banner)).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});
