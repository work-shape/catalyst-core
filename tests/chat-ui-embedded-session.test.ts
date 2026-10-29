// @vitest-environment happy-dom

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import {
  mountPage,
  personalWorkspace,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";
import { settingsCatalog, SkillMyChats, visibleSettingsPages } from "./support/chat-ui";
import { required } from "./support/assertions";

// A chat embedded in a host's page acts with the host's session token, which the server does not
// take for the person in their own session. The interface leaves out what the server refuses it:
// the pages and actions here are shown in the person's own session and gone in the embedded one.

const catalog = settingsCatalog(administration);
const embedded = { embedded: true } as const;

function pageIds(user: Parameters<typeof settingsUser>[0]): string[] {
  const modules = {
    connections: { enabled: true },
    personalApiKeys: { enabled: true }
  } as const;
  const viewer = {
    user: settingsUser(user),
    workspaces: [personalWorkspace()],
    modules: {
      ...settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL })).config.modules,
      ...modules
    }
  };
  return visibleSettingsPages(catalog, viewer)
    .filter((page) => page.group === "you")
    .map((page) => page.id);
}

describe("Settings in an embedded session", () => {
  it("leaves out the person's confirmations, Connections and keys, which their own session has", () => {
    expect(pageIds({})).toEqual(
      expect.arrayContaining(["confirmations", "connections", "api-keys", "connect"])
    );
    const shown = pageIds(embedded);
    for (const own of ["confirmations", "connections", "api-keys", "connect"]) {
      expect(shown).not.toContain(own);
    }
    expect(shown).toContain("profile");
  });

  it.each(["en", "de"] as const)(
    "offers no account deletion in the profile (%s), which the person's own session does",
    async (locale) => {
      const profile = required(
        catalog.find((page) => page.group === "you" && page.id === "profile")
      );
      const client = createApiClient({
        baseUrl: SETTINGS_INSTANCE_URL,
        fetchImpl: async () => Response.json({ items: [] })
      });
      // The Section's own sentence: the closed dialog names the account as well.
      const deleteSection =
        locale === "en" ? "Permanently removes your user profile" : "Löscht dein Benutzerprofil";
      const details = locale === "en" ? "Your details" : "Deine Angaben";

      const own = await mountPage(
        settingsPageContext(client),
        locale,
        createElement(profile.component)
      );
      await waitForText(own.container, deleteSection);
      await own.unmount();

      const host = await mountPage(
        settingsPageContext(client, settingsUser(embedded)),
        locale,
        createElement(profile.component)
      );
      await waitForText(host.container, details);
      expect(host.container.textContent).not.toContain(deleteSection);
      await host.unmount();
    }
  );

  it("does not ask for the person's own skills, which their own session reads", async () => {
    const asked: string[] = [];
    const client = createApiClient({
      baseUrl: SETTINGS_INSTANCE_URL,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        asked.push(new URL(request.url).pathname);
        return Response.json({ items: [{ name: "steuer", inMyChats: true }] });
      }
    });
    const frame = { asset: { name: "steuer" }, owner: "cw_personal" };
    const section = (): ReturnType<typeof createElement> =>
      createElement(SkillMyChats, {
        frame,
        children: (parts) =>
          createElement("div", { "data-parts": "" }, parts.section?.body ?? "none")
      });

    const own = await mountPage(settingsPageContext(client), "en", section());
    await waitForText(own.container, "Use in my chats");
    await own.unmount();
    expect(asked.length).toBeGreaterThan(0);

    asked.length = 0;
    const host = await mountPage(
      settingsPageContext(client, settingsUser(embedded)),
      "en",
      section()
    );
    await waitForText(host.container, "none");
    expect(asked).toEqual([]);
    await host.unmount();
  });
});
