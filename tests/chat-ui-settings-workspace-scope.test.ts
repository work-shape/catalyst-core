import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createApiClient, type LocaleCode } from "@work-shape/catalyst-api-client";
import { SettingsArea } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import {
  personalWorkspace,
  settingsPageContext,
  sharedWorkspace
} from "./chat-ui-settings-fixtures";

// ACCEPT-1c, cosmetic: in Mara's personal workspace Settings › Workspace showed the shared
// workspace "Nordlicht Beratung" as if it were where she works. The Workspace pages change a
// shared workspace only, and the scope says so while the person works in their own.

const shared = sharedWorkspace({ name: "Nordlicht Beratung" });

function settingsRail(active: typeof shared, locale: LocaleCode = "en"): string {
  const context = {
    ...settingsPageContext(createApiClient({ baseUrl: "https://chat.example.com" })),
    workspace: shared,
    activeWorkspace: active
  };
  const page = (id: string, group: "you" | "workspace") => ({
    id,
    group,
    labelKey: "settings.general" as const,
    component: () => null,
    visible: () => true
  });
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale, children: null },
      createElement(SettingsArea, {
        settings: {
          pages: [page("profile", "you"), page("general", "workspace")],
          page: undefined,
          noAccess: false,
          workspaces: [shared],
          selectWorkspace: () => undefined,
          openPage: () => undefined,
          context
        }
      })
    )
  );
}

describe("The scope of the Workspace settings", () => {
  it("names the shared workspace as shared while the person works in their personal one", () => {
    const personal = settingsRail(personalWorkspace());
    expect(personal).toContain("Nordlicht Beratung");
    expect(personal).toContain("data-workspace-scope-shared");
    expect(personal).toContain("Shared workspace");
    expect(settingsRail(personalWorkspace(), "de")).toContain("Geteilter Arbeitsbereich");
  });

  it("names only the workspace while the person works in it", () => {
    const inShared = settingsRail(shared);
    expect(inShared).toContain("Nordlicht Beratung");
    expect(inShared).not.toContain("data-workspace-scope-shared");
  });
});
