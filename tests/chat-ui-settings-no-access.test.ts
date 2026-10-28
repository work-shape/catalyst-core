import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createApiClient, type LocaleCode } from "@work-shape/catalyst-api-client";
import { SettingsArea } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { settingsPageContext, settingsUser } from "./chat-ui-settings-fixtures";

// ACCEPT-FIX-10 C10: a member who opened Instance › Usage landed in Studio without a word. The
// closed page now says it cannot be opened, whom to ask, and leads to the person's own settings.

function closedPage(locale: LocaleCode, instanceAdminName?: string): string {
  const context = settingsPageContext(
    createApiClient({ baseUrl: "https://chat.example.com" }),
    settingsUser({ instanceAdminName })
  );
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale, children: null },
      createElement(SettingsArea, {
        settings: {
          pages: [
            {
              id: "profile",
              group: "you",
              labelKey: "settings.general",
              component: () => null,
              visible: () => true
            }
          ],
          page: undefined,
          noAccess: true,
          workspaces: [],
          selectWorkspace: () => undefined,
          openPage: () => undefined,
          context
        }
      })
    )
  );
}

describe("a Settings page the person cannot open", () => {
  it.each([
    {
      locale: "en" as const,
      said: "You cannot open this page: it needs a right you do not have. Ask an admin for all workspaces, for example Mara Lindqvist.",
      go: "Open your profile"
    },
    {
      locale: "de" as const,
      said: "Diese Seite kannst du nicht öffnen: Dafür fehlt dir ein Recht. Frag einen Admin für alle Arbeitsbereiche, zum Beispiel Mara Lindqvist.",
      go: "Zu deinem Profil"
    }
  ])("says why, whom to ask and where to go ($locale)", ({ locale, said, go }) => {
    const markup = closedPage(locale, "Mara Lindqvist");
    expect(markup).toContain(said);
    expect(markup).toMatch(new RegExp(`<button[^>]*>${go}</button>`, "u"));
  });
});
