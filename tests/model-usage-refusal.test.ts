import { describe, expect, it } from "vitest";
import { modelUsageRefusalOf } from "@work-shape/catalyst-core";

// LU-5: a refusal at a usage limit reaches an App, a Workflow run and a person as the details
// of an error. Only a refusal that names a limit this release knows is read as that limit.
describe("the usage limit named by the details of an error", () => {
  const named = {
    reason: "MODEL_USAGE_LIMIT_REACHED",
    period: "month",
    metric: "costMicros",
    scope: "workspace"
  };

  it("reads the period, what it counts and whose calls", () => {
    expect(modelUsageRefusalOf(named)).toEqual({
      period: "month",
      metric: "costMicros",
      scope: "workspace"
    });
    // Nothing else in the details is carried over.
    expect(modelUsageRefusalOf({ ...named, action: "x", operationRunId: "oprun_1" })).toEqual({
      period: "month",
      metric: "costMicros",
      scope: "workspace"
    });
  });

  it("names no limit for another reason, a part this release does not know, or no details", () => {
    expect(modelUsageRefusalOf({ ...named, reason: "no_grant" })).toBeUndefined();
    expect(modelUsageRefusalOf({ ...named, scope: "team" })).toBeUndefined();
    expect(modelUsageRefusalOf({ ...named, period: undefined })).toBeUndefined();
    expect(modelUsageRefusalOf({ reason: "MODEL_USAGE_LIMIT_REACHED" })).toBeUndefined();
    expect(modelUsageRefusalOf(undefined)).toBeUndefined();
    expect(modelUsageRefusalOf(null)).toBeUndefined();
    expect(modelUsageRefusalOf("MODEL_USAGE_LIMIT_REACHED")).toBeUndefined();
  });
});
