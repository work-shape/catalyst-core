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
  locale: "en" | "de",
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
    locale,
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
  it.each([
    {
      list: "members",
      path: membersPath,
      said: "Du darfst die Mitglieder dieses Arbeitsbereichs nicht sehen. Frag jemanden, der die Instanz verwaltet, zum Beispiel Mara."
    },
    {
      list: "requests",
      path: requestsPath,
      said: "Du darfst die Beitrittsanfragen dieses Arbeitsbereichs nicht sehen. Frag jemanden, der die Instanz verwaltet, zum Beispiel Mara."
    }
  ])(
    "a refused $list list names whom to ask, as information without a retry",
    async ({ path, said }) => {
      const mounted = await mountMembers("de", {
        [membersPath]: () => Response.json({ items: [member] }),
        [path]: refused
      });
      try {
        await waitForText(mounted.container, said);
        expect(bannerSaying(mounted.container, said).getAttribute("data-tone")).toBe("info");
        expect(buttonNamed(mounted.container, "Erneut versuchen")).toBeUndefined();
      } finally {
        await mounted.unmount();
      }
    }
  );

  it.each([
    { list: "members", path: membersPath, said: "Members could not be loaded." },
    { list: "requests", path: requestsPath, said: "Access requests could not be loaded." }
  ])("a failed $list list is an error with a retry that asks again", async ({ path, said }) => {
    const mounted = await mountMembers("en", {
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
  it.each([
    {
      locale: "en" as const,
      approve: "Approve",
      requests: "Requests",
      said: "You can't approve requests in this workspace. Ask an instance admin, for example Mara."
    },
    {
      locale: "de" as const,
      approve: "Genehmigen",
      requests: "Anfragen",
      said: "Du darfst Anfragen in diesem Arbeitsbereich nicht genehmigen. Frag jemanden, der die Instanz verwaltet, zum Beispiel Mara."
    }
  ])(
    "a refused Approve is said at the top of Requests, naming the action ($locale)",
    async ({ locale, approve, requests, said }) => {
      const mounted = await mountMembers(locale, {
        [membersPath]: () => Response.json({ items: [member] }),
        [requestsPath]: () => Response.json({ items: [requester] }),
        [approvePath]: refused
      });
      try {
        await waitForText(mounted.container, "Jonas Weber");
        await act(async () => {
          required(buttonNamed(mounted.container, approve)).click();
        });
        await waitForText(mounted.container, said);
        const banner = bannerSaying(mounted.container, said);
        expect(banner.getAttribute("data-tone")).toBe("info");
        const section = required(banner.closest("section"));
        expect(section.querySelector("h2")?.textContent).toBe(requests);
        // First in the section's content, before the request it concerns.
        const row = required(
          section.querySelector('[data-testid="collaboration-workspace-request-row"]')
        );
        expect(banner.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(row.textContent).toContain("Jonas Weber");
        // Nowhere else, and not above the members.
        expect(mounted.container.textContent?.split(said)).toHaveLength(2);
        const members = required(
          mounted.container.querySelector('[data-testid="collaboration-workspace-members"]')
        );
        expect(members.contains(banner)).toBe(false);
      } finally {
        await mounted.unmount();
      }
    }
  );
});

describe("Workspace > Members, its description", () => {
  // Builder and Publisher reach only assets the workspace owns, never its conversations,
  // Projects or members' files. Name the owner and examples in both languages.
  it.each([
    {
      locale: "en" as const,
      said: "Members use this workspace's agents and apps and work in its conversations. Builders may also edit what this workspace owns, such as its agents and apps; Publishers may publish it. An instance admin grants these rights."
    },
    {
      locale: "de" as const,
      said: "Mitglieder verwenden die Agenten und Apps dieses Arbeitsbereichs und arbeiten in seinen Unterhaltungen. Wer das Recht zum Bearbeiten hat, darf zusätzlich bearbeiten, was dem Arbeitsbereich gehört, etwa seine Agenten und Apps; wer das Recht zum Veröffentlichen hat, darf es veröffentlichen. Beide Rechte vergibt jemand, der die Instanz verwaltet."
    }
  ])("limits the extra rights to what this workspace owns ($locale)", async ({ locale, said }) => {
    const mounted = await mountMembers(locale, {
      [membersPath]: () => Response.json({ items: [member] })
    });
    try {
      await waitForText(mounted.container, said);
      if (locale === "de") {
        expect(mounted.container.textContent).not.toMatch(/Builder|Publisher|ihm gehört|Inhalte/u);
      }
    } finally {
      await mounted.unmount();
    }
  });
});
