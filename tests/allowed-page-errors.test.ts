import { describe, expect, it } from "vitest";
import { isAllowed } from "../e2e/allowed-page-errors";

const message = "Failed to load resource: the server responded with a status of 404 (Not Found)";
const title = "collaboration workspaces scope navigation, settings, and discovery";

describe("the browser's deliberate missing-workspace request", () => {
  it("accepts both reads of the named nonexistent workspace in its fallback test", () => {
    for (const suffix of ["", "/agents"])
      expect(
        isAllowed(message, `http://localhost/api/v1/workspaces/cw_not_a_workspace${suffix}`, title)
      ).toBe(true);
  });

  it("still reports missing real workspaces and other tests' errors", () => {
    expect(isAllowed(message, "http://localhost/api/v1/workspaces/real_workspace", title)).toBe(
      false
    );
    expect(
      isAllowed(
        message,
        "http://localhost/api/v1/workspaces/cw_not_a_workspace",
        "an unrelated test"
      )
    ).toBe(false);
  });
});
