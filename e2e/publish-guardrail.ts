import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect } from "./test";

/** "Publishing needs an instance admin's approval", which the release ships off (PUB-LIVE-1). */
const PUBLISH_GUARDRAIL = "publishing-needs-approval";

/**
 * An instance admin switches the shipped publish guardrail on or off for the whole instance. A
 * spec that switches it on switches it off again: the specs of a shard share one instance.
 */
export async function switchPublishGuardrail(
  page: Page,
  apiBaseUrl: string,
  enabled: boolean
): Promise<void> {
  const switched = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/guardrails/shipped/${PUBLISH_GUARDRAIL}/switch`,
    { data: { enabled } }
  );
  expect(switched.ok(), await switched.text()).toBe(true);
}
