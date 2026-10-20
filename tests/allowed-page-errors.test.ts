import { describe, expect, it } from "vitest";
import { isAllowed, requestAnswered, type AllowedPageError } from "../e2e/allowed-page-errors";

const message = "Failed to load resource: the server responded with a status of 404 (Not Found)";
const title = "collaboration workspaces scope navigation, settings, and discovery";

// An entry as a spec declares it with `test.use({ allowedPageErrors })`.
const specErrors: readonly AllowedPageError[] = [
  {
    name: "workspace-that-is-gone",
    reason: "The test opens a workspace that does not exist.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/(?:conversations|workspaces\/cw_not_a_workspace(?:\/agents)?)$/u,
    tests: [title]
  }
];

describe("a spec's own allowed page errors", () => {
  it("accept both reads of the named nonexistent workspace in its fallback test", () => {
    for (const suffix of ["", "/agents"])
      expect(
        isAllowed(
          message,
          `http://localhost/api/v1/workspaces/cw_not_a_workspace${suffix}`,
          title,
          specErrors
        )
      ).toBe(true);
  });

  it("still report missing real workspaces, other tests' errors, and errors of other specs", () => {
    expect(
      isAllowed(message, "http://localhost/api/v1/workspaces/real_workspace", title, specErrors)
    ).toBe(false);
    expect(
      isAllowed(
        message,
        "http://localhost/api/v1/workspaces/cw_not_a_workspace",
        "an unrelated test",
        specErrors
      )
    ).toBe(false);
    expect(isAllowed(message, "http://localhost/api/v1/workspaces/cw_not_a_workspace", title)).toBe(
      false
    );
  });
});

describe("the shared allowed page errors", () => {
  it("let the signed-out read of the person through in every test", () => {
    expect(
      isAllowed(
        "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
        "http://localhost/api/v1/me",
        "any test"
      )
    ).toBe(true);
  });
});
