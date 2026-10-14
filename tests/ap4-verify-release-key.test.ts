import { describe, expect, it } from "vitest";
import { putAgent, setupRelease, syncAsService } from "./support/asset-release";

// AP-4 verifier: before AP-4 a service principal's token carried only the keys whose scope its
// API key holds (`deriveEffectiveServiceGrants`), and the evaluator read that narrowed list. A
// key issued for release sync alone (`config_assets:release`) on a principal that also holds
// `config_assets.read` therefore held no `agent.read`. The evaluator now reads the principal's
// rows, so that key reads through the sync what its scope never gave it.

describe("a release-only key after AP-4", () => {
  it("is told nothing of a stale asset's history, as its scope gives no read", async () => {
    const t = await setupRelease();
    // rel-old is at revision 1; the batch names revision 7.
    const pushed = await syncAsService(t, [putAgent("rel-old", {}, 7)], "config_assets:release");
    expect(pushed.statusCode, pushed.body).toBe(412);
    expect(pushed.body).not.toContain("currentRevision");
  });
});
