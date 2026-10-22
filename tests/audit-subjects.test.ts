import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  auditSubjectOf,
  createPlatformId,
  projectAuditActivities,
  type AccessResource,
  type AuditEvent,
  type AuthenticatedUser,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { withAuditSubjects, type AuditSubjectLookups } from "@work-shape/catalyst-server";

// UXA-1b3: the audit view's "Betrifft" says what an event is about in what its reader may read:
// an asset's title, a person's or workspace's name, a tool's title, else its kind alone. The id
// the row stores is never what the reader is sent to read.

const clientInstanceId = asClientInstanceId("client_test");
const reader: AuthenticatedUser = {
  id: "user_reader",
  externalUserId: "reader",
  displayLabel: "Rita Reader",
  roles: ["admin"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};

let sequence = 0;
function event(partial: Partial<AuditEvent> & Pick<AuditEvent, "type">): AuditEvent {
  sequence += 1;
  return {
    id: createPlatformId("audit"),
    clientInstanceId,
    status: "success",
    correlationId: `corr_${sequence}`,
    createdAt: `2026-10-22T08:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...partial
  };
}

describe("what an audit row is about (UXA-1b3)", () => {
  it("reads the subject from the row's kind, name, id or type", () => {
    expect(
      auditSubjectOf(
        event({ type: "config_asset.published", metadata: { kind: "agent", name: "sales" } })
      )
    ).toEqual({ kind: "agent", name: "sales" });
    expect(
      auditSubjectOf(
        event({
          type: "operation.completed",
          subject: "demo.weather_forecast",
          metadata: { subjectKind: "operation" }
        })
      )
    ).toEqual({ kind: "operation", operation: "demo.weather_forecast" });
    expect(
      auditSubjectOf(
        event({
          type: "operation.completed",
          subject: "5b3c1d6e-0000-4000-8000-000000000001",
          metadata: { subjectKind: "connection", connectionName: "crm" }
        })
      )
    ).toEqual({ kind: "connection", name: "crm" });
    expect(auditSubjectOf(event({ type: "user.updated", subject: "user_ada" }))).toEqual({
      kind: "user",
      userId: "user_ada"
    });
    // A session token names the person by an outside id: said by its kind alone.
    expect(
      auditSubjectOf(event({ type: "auth.session_token_issued", subject: "ext|ada" }))
    ).toEqual({ kind: "auth" });
    expect(auditSubjectOf(event({ type: "governance.audit_events_viewed" }))).toBeUndefined();
  });

  it("says the title the reader may read and only the kind of what they may not", async () => {
    const events = [
      event({ type: "config_asset.published", metadata: { kind: "agent", name: "sales" } }),
      event({ type: "config_asset.updated", metadata: { kind: "skill", name: "secret-skill" } }),
      event({ type: "user.updated", subject: "user_ada" }),
      event({ type: "conversation.renamed", subject: "conv_other" }),
      event({ type: "conversation.renamed", subject: "conv_own" }),
      event({
        type: "operation.completed",
        subject: "demo.weather_forecast",
        metadata: { subjectKind: "operation" }
      }),
      event({ type: "role.updated", subject: "admin" }),
      event({ type: "permission.granted", subject: "grant_1" })
    ];
    const lookups: string[] = [];
    const activities = await withAuditSubjects(
      fakeLookups(lookups),
      {
        user: reader,
        // The reader may read this agent, not this skill, and may not manage people.
        access: {
          authorize: (action: string, resource?: AccessResource) =>
            action === "agent.read" && resource?.name === "sales"
              ? { allowed: true, source: "role" }
              : { allowed: false, reason: "no_grant" }
        },
        locale: "de"
      },
      projectAuditActivities(events, { view: "all" })
    );
    const about = activities.flatMap((activity) => activity.evidence.map((each) => each.about));
    expect(about).toEqual(
      expect.arrayContaining([
        { kind: "agent", title: "Vertriebsassistent" },
        { kind: "skill" },
        { kind: "user" },
        { kind: "conversation" },
        { kind: "conversation", title: "Meine Unterhaltung" },
        { kind: "operation", title: "Wettervorhersage" },
        { kind: "role" },
        { kind: "permission_grant" }
      ])
    );
    expect(about).toHaveLength(events.length);
    // What the reader may not read is not looked up past the right that refuses it.
    expect(lookups).not.toContain("user:user_ada");
    // No title, label or word sent names an id or a slug.
    const sent = JSON.stringify(
      activities.map((activity) => ({
        label: activity.target?.label,
        about: activity.evidence.map((each) => each.about)
      }))
    );
    for (const id of [
      "secret-skill",
      "user_ada",
      "conv_other",
      "demo.weather_forecast",
      "grant_1"
    ]) {
      expect(sent).not.toContain(id);
    }
  });
});

function fakeLookups(lookups: string[]): AuditSubjectLookups {
  const titles = new Map([
    ["agent:sales", "Vertriebsassistent"],
    ["skill:secret-skill", "Geheimer Skill"]
  ]);
  const record = (kind: string, name: string, title: string): ConfigAssetRecord => ({
    id: `asset_${name}`,
    clientInstanceId,
    kind,
    name,
    scope: { kind: "instance" },
    status: "active",
    activeRevisionId: `revision_${name}`,
    revision: 1,
    config: { title },
    createdAt: "2026-10-22T08:00:00.000Z",
    updatedAt: "2026-10-22T08:00:00.000Z"
  });
  return {
    asset: async (kind, name) => {
      lookups.push(`${kind}:${name}`);
      const title = titles.get(`${kind}:${name}`);
      return title ? record(kind, name, title) : undefined;
    },
    assetById: async () => undefined,
    assetTitle: (_kind, name, config) => (typeof config.title === "string" ? config.title : name),
    kindOff: () => false,
    userName: async (userId) => {
      lookups.push(`user:${userId}`);
      return "Ada Lovelace";
    },
    reachableWorkspaceName: async () => undefined,
    role: async () => undefined,
    conversation: async (id) => ({
      title: id === "conv_own" ? "Meine Unterhaltung" : "Fremde Unterhaltung",
      createdByUserId: id === "conv_own" ? reader.id : "user_other"
    }),
    tools: () => [
      { name: "demo.weather_forecast", title: { en: "Weather forecast", de: "Wettervorhersage" } }
    ]
  };
}
