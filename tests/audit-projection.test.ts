import { describe, expect, it } from "vitest";
import {
  projectAuditActivities,
  reasonForEvent,
  type AuditEvent,
  type AuditActor
} from "@vivd-catalyst/core";

let sequence = 0;

function evt(partial: Partial<AuditEvent> & Pick<AuditEvent, "type">): AuditEvent {
  sequence += 1;
  return {
    id: `audit_${sequence}`,
    clientInstanceId: "client_test",
    status: "success",
    correlationId: "corr_default",
    createdAt: `2026-06-30T08:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...partial
  } as AuditEvent;
}

const human: AuditActor = {
  userId: "user_felix",
  externalUserId: "felix",
  displayLabel: "Felix Pahlke",
  roles: ["admin"],
  principalKind: "user"
};

describe("projectAuditActivities", () => {
  it("groups a message turn and its tool evidence into one activity", () => {
    const events = [
      evt({
        type: "message.completed",
        correlationId: "corr_turn",
        subject: "conv_1",
        actor: human,
        metadata: { conversationId: "conv_1" },
        createdAt: "2026-06-30T08:10:27.000Z"
      }),
      evt({
        type: "tool.completed",
        correlationId: "corr_turn",
        subject: "view_document_page",
        actor: human,
        createdAt: "2026-06-30T08:10:22.000Z"
      }),
      evt({
        type: "tool.started",
        correlationId: "corr_turn",
        subject: "view_document_page",
        actor: human,
        createdAt: "2026-06-30T08:10:21.000Z"
      })
    ];

    const activities = projectAuditActivities(events);

    expect(activities).toHaveLength(1);
    const [activity] = activities;
    // message.completed outranks the tool events and titles the activity.
    expect(activity!.label).toBe("Assistant responded");
    expect(activity!.tier).toBe("workflow");
    expect(activity!.target).toEqual({ kind: "conversation", id: "conv_1" });
    expect(activity!.eventCount).toBe(3);
    // The activity timestamp is the most recent moment in the group.
    expect(activity!.at).toBe("2026-06-30T08:10:27.000Z");
    // Evidence is newest-first.
    expect(activity!.evidence.map((event) => event.type)).toEqual([
      "message.completed",
      "tool.completed",
      "tool.started"
    ]);
  });

  it("flags a successful turn with a failed tool as a warning", () => {
    const activities = projectAuditActivities([
      evt({ type: "message.completed", correlationId: "c", status: "success", actor: human }),
      evt({ type: "tool.completed", correlationId: "c", status: "failed", actor: human })
    ]);
    expect(activities[0]!.outcome).toBe("warning");
  });

  it("surfaces an inner denial at the activity level", () => {
    const activities = projectAuditActivities([
      evt({ type: "message.completed", correlationId: "c", status: "success", actor: human }),
      evt({
        type: "tool.authorization_checked",
        correlationId: "c",
        status: "denied",
        actor: human,
        metadata: { reason: "not_allowed" }
      })
    ]);
    expect(activities[0]!.outcome).toBe("denied");
    expect(activities[0]!.reason).toBe("not_allowed");
  });

  it("hides successful runtime-only activity by default but keeps it when it fails", () => {
    const successful = evt({
      type: "workspace_command.completed",
      correlationId: "wc_ok",
      status: "success"
    });
    const failed = evt({
      type: "workspace_command.failed",
      correlationId: "wc_bad",
      status: "failed",
      reason: "exit_1"
    });

    const defaultView = projectAuditActivities([successful, failed]);
    expect(defaultView.map((activity) => activity.label)).toEqual(["Workspace command failed"]);

    const allView = projectAuditActivities([successful, failed], { view: "all" });
    expect(allView).toHaveLength(2);
  });

  it("collapses consecutive identical governance reads", () => {
    const reads = [0, 1, 2].map((index) =>
      evt({
        type: "governance.audit_events_viewed",
        correlationId: `read_${index}`,
        actor: human,
        createdAt: `2026-06-30T09:0${index}:00.000Z`
      })
    );

    const activities = projectAuditActivities(reads);

    expect(activities).toHaveLength(1);
    expect(activities[0]!.label).toBe("Viewed the audit log");
    expect(activities[0]!.repeatCount).toBe(3);
    expect(activities[0]!.tier).toBe("governance");
  });

  it("resolves an assistant acting on behalf of a human", () => {
    const delegated: AuditActor = {
      ...human,
      delegatedActor: { kind: "service_principal", id: "svc_agent", displayLabel: "Agent", authSource: "system" }
    };
    const [activity] = projectAuditActivities([
      evt({ type: "tool.completed", correlationId: "c", actor: delegated, status: "failed" })
    ]);
    expect(activity!.actor).toMatchObject({
      kind: "assistant",
      label: "Agent",
      onBehalfOf: "Felix Pahlke"
    });
  });

  it("treats actorless events as system", () => {
    const [activity] = projectAuditActivities([
      evt({ type: "workspace_command.failed", correlationId: "c", status: "failed" })
    ]);
    expect(activity!.actor).toEqual({ kind: "system", label: "System" });
  });

  it("labels workspace tool runs from their audit summary action", () => {
    const [activity] = projectAuditActivities(
      [
        evt({
          type: "tool.completed",
          correlationId: "c",
          status: "failed",
          subject: "workspace.exec",
          metadata: { auditAction: "workspace.exec", auditSubject: "wcmd_1" }
        })
      ],
      { view: "all" }
    );
    expect(activity!.label).toBe("Ran a command");
    expect(activity!.target).toMatchObject({ kind: "tool", id: "wcmd_1" });
  });

  it("orders activities newest-first and respects the limit", () => {
    const older = evt({
      type: "user.updated",
      correlationId: "old",
      actor: human,
      createdAt: "2026-06-30T07:00:00.000Z"
    });
    const newer = evt({
      type: "user.created",
      correlationId: "new",
      actor: human,
      createdAt: "2026-06-30T09:00:00.000Z"
    });

    const activities = projectAuditActivities([older, newer], { limit: 1 });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.label).toBe("Created a user");
  });
});

describe("reasonForEvent", () => {
  it("prefers the explicit reason, then metadata.reason, then metadata.code", () => {
    expect(reasonForEvent(evt({ type: "tool.failed", reason: "boom" }))).toBe("boom");
    expect(reasonForEvent(evt({ type: "tool.failed", metadata: { reason: "denied_x" } }))).toBe(
      "denied_x"
    );
    expect(reasonForEvent(evt({ type: "tool.failed", metadata: { code: "handler_failed" } }))).toBe(
      "handler_failed"
    );
    expect(reasonForEvent(evt({ type: "tool.completed" }))).toBeUndefined();
  });
});
