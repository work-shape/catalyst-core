import { createElement, Fragment, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import { UserMenu } from "../packages/chat-ui/src/workspace/user-menu";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";

/**
 * The library's menu shows its content in an overlay, and an overlay exists only in a browser.
 * Here the parts of the menu are plain elements, so the markup holds what the open menu says.
 * Opening it, and where it stands, is the browser suite's.
 */
vi.mock("@vivd-catalyst/ui", async (importOriginal) => {
  const library = await importOriginal<typeof import("@vivd-catalyst/ui")>();
  const passThrough = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    ...library,
    DropdownMenu: passThrough,
    DropdownMenuTrigger: passThrough,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) =>
      createElement("div", { role: "menu" }, children),
    DropdownMenuGroup: ({ label, children }: { label?: ReactNode; children?: ReactNode }) =>
      createElement("div", { role: "group" }, label, children),
    DropdownMenuItem: ({ children }: { children?: ReactNode }) =>
      createElement("div", { role: "menuitem" }, children),
    DropdownMenuSeparator: () => createElement("hr")
  };
});

const noop = () => undefined;

function menu(
  platform: { instanceName: string; releaseVersion: string } | undefined,
  locale: LocaleCode = "en"
): string {
  const markup = renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(UserMenu, {
        user: settingsUser(),
        signingOut: false,
        themeMode: "light",
        platform,
        onOpenProfile: noop,
        onOpenLanguageAppearance: noop,
        onToggleTheme: noop,
        onSignOut: noop
      })
    )
  );
  return /<div role="menu">.*<\/div>/u.exec(markup)?.[0] ?? "";
}

/** The line at the foot of the menu, as text. */
function identity(markup: string): string | undefined {
  return /<p[^>]*data-platform-identity=""[^>]*>(.*?)<\/p>/u
    .exec(markup)?.[1]
    ?.replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("account menu", () => {
  it("names the instance and the release it runs at its foot", () => {
    const markup = menu({ instanceName: "Catalyst Staging", releaseVersion: "1.4.0" });

    expect(identity(markup)).toBe("Catalyst Staging Version 1.4.0");
    // The line is the last thing in the menu, after sign out.
    expect(markup.indexOf("Sign out")).toBeGreaterThan(-1);
    expect(markup.indexOf("Sign out")).toBeLessThan(markup.indexOf("data-platform-identity"));
    expect(markup.endsWith("</p></div>")).toBe(true);
  });

  it("names the release in the reader's language", () => {
    expect(identity(menu({ instanceName: "Catalyst", releaseVersion: "2026.10.1" }, "de"))).toBe(
      "Catalyst Version 2026.10.1"
    );
  });

  it("has no line about the instance until the instance answered", () => {
    const markup = menu(undefined);

    expect(markup).not.toContain("data-platform-identity");
    expect(markup).not.toContain("Version");
    expect(markup).toContain("Sign out");
    expect(markup).toContain("felix@example.com");
  });
});
