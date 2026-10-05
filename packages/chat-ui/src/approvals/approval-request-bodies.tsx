import type { ComponentType } from "react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { SkillChangeBody } from "./skill-change-body";

/**
 * Platform-owned request kinds only. This is deliberately not the client
 * widget registry: an approval card decides a change to the instance, so its
 * body must not be replaceable by a client assembly.
 */
const APPROVAL_REQUEST_BODIES = new Map<string, ComponentType<{ preview: unknown }>>([
  ["skill_change", SkillChangeBody]
]);

/** An unknown kind renders no body; the card's summary still describes the request. */
export function ApprovalRequestBody({ request }: { request: ApprovalRequestView }) {
  const Body = APPROVAL_REQUEST_BODIES.get(request.kind);
  return Body ? <Body preview={request.preview} /> : null;
}
