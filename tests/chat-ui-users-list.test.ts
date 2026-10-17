import { createElement } from "react";
import type { AdministeredUser } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { UserAdministrationPanel } from "@work-shape/catalyst-chat-ui/control-plane";
import { filterUsers, userDisplayStatus, userStatusFilterOf } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Instance > Users (UXA-5a): the name keeps its room while the other columns fold, sign-in
// methods live in the person's detail, and an account nobody has signed in to reads "Invited".
// The detail and the folding itself are read in the browser, in e2e/users-list.spec.ts.

function user(overrides: Partial<AdministeredUser> = {}): AdministeredUser {
  return {
    id: "user-1",
    clientInstanceId: "client-1",
    displayLabel: "Annemarie Schwarzenberger-Hohenlohe",
    email: "annemarie@example.test",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status: "active",
    createdAt: "2026-10-01T08:00:00Z",
    updatedAt: "2026-10-01T08:00:00Z",
    identities: [],
    ...overrides
  };
}

const signedIn = { lastAuthenticatedAt: "2026-10-15T09:30:00Z" };
const unused = async () => {
  throw new Error("not called in a render");
};

function panel(users: AdministeredUser[], locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(UserAdministrationPanel, {
        users,
        loading: false,
        canManageSuperadminAccess: true,
        mutating: false,
        onCreateUser: unused,
        onUpdateUser: unused,
        onDeleteUser: unused,
        onUpsertIdentity: unused,
        onDeleteIdentity: unused,
        onResetPassword: unused
      })
    )
  );
}

describe("the status an account reads with", () => {
  it("is invited for an active account nobody has signed in to yet, and the stored status else", () => {
    expect(userDisplayStatus(user())).toBe("invited");
    expect(userDisplayStatus(user(signedIn))).toBe("active");
    // The contract keeps no invitation, so only an account that could sign in reads invited.
    expect(userDisplayStatus(user({ status: "disabled" }))).toBe("disabled");
    expect(userDisplayStatus(user({ status: "deleting" }))).toBe("deleting");
  });

  it("is what the status filter selects by", () => {
    const invited = user({ id: "invited" });
    const active = user({ id: "active", ...signedIn });
    const filter = (value: string) =>
      filterUsers([invited, active], {
        search: "",
        statusFilter: userStatusFilterOf(value),
        roleFilter: "all"
      }).map((shown) => shown.id);

    expect(filter("invited")).toEqual(["invited"]);
    expect(filter("active")).toEqual(["active"]);
    expect(filter("all")).toEqual(["invited", "active"]);
    expect(filter("pending")).toEqual(["invited", "active"]);
  });
});

describe("Instance > Users", () => {
  const markup = panel([
    user({ id: "invited" }),
    user({ id: "active", displayLabel: "Mara Oyelaran", email: undefined, ...signedIn })
  ]);
  const rows = /<tbody\b.*<\/tbody>/u.exec(markup)?.[0] ?? "";
  const heads = [...markup.matchAll(/<th\b([^>]*)>(.*?)<\/th>/gu)];

  it("counts and shows an invited person as invited, not active", () => {
    expect(markup).toContain("2 users · 1 active · 1 invited");
    expect(markup.match(/>Invited</gu)).toHaveLength(2); // the filter's option and the badge
    expect(markup).toContain('<option value="invited">Invited</option>');
  });

  // The head said "1 users" of a single account.
  it.each([
    {
      locale: "en" as const,
      said: ["0 users · 0 active<", "1 user · 1 active<", "2 users · 2 active<"]
    },
    {
      locale: "de" as const,
      said: ["0 Benutzer · 0 aktiv<", "1 Benutzer · 1 aktiv<", "2 Benutzer · 2 aktiv<"]
    }
  ])("counts none, one and two people in the right number ($locale)", ({ locale, said }) => {
    const people = [user({ id: "a", ...signedIn }), user({ id: "b", ...signedIn })];
    expect([0, 1, 2].map((count) => panel(people.slice(0, count), locale))).toEqual(
      said.map((summary) => expect.stringContaining(summary))
    );
    expect(panel([user()], "en")).toContain("1 user · 0 active · 1 invited<");
    expect(panel([user()], "de")).toContain("1 Benutzer · 0 aktiv · 1 eingeladen<");
  });

  it("reads Eingeladen in German for a person who never signed in, as its filter does", () => {
    const german = panel([user()], "de");
    expect(german.match(/>Eingeladen</gu)).toHaveLength(2); // the filter's option and the badge
    expect(german).not.toMatch(/>Aktiv<\/span>/u);
  });

  it("folds Last active, then Access, then Status into the details under the full name", () => {
    expect(
      heads.map(([, attributes, label]) => [
        label,
        /data-column="(\d)"/u.exec(attributes ?? "")?.[1]
      ])
    ).toEqual([
      [expect.stringContaining('role="checkbox"'), undefined],
      ["User", undefined],
      ["Access", "2"],
      ["Status", "3"],
      ["Last active", "4"],
      ["", undefined]
    ]);
    expect(markup).not.toContain("Sign-in methods");
    // The name and the address wrap where room runs out, and are never cut.
    expect(markup).toContain(
      '<span class="font-medium wrap-anywhere">Annemarie Schwarzenberger-Hohenlohe</span>'
    );
    expect(rows).not.toMatch(/truncate/u);
  });

  it("selects with the library's checkbox and names no account by its id", () => {
    // One box for the page, one per row and the password sign-in of the New user form, which
    // the page holds closed: all the library's.
    expect(markup.match(/<button type="button" role="checkbox"/gu)).toHaveLength(4);
    expect(markup).toContain('aria-label="Select visible users"');
    expect(markup).toContain('aria-label="Select Mara Oyelaran"');
    expect(markup).not.toMatch(/>active</u);
  });
});
