import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  CONNECTION_BINDING_REFUSALS,
  SHARED_CREDENTIAL_SUBJECT,
  type ApprovalRequestHandler,
  type ApprovalRequestStore,
  type AccessResource,
  type ClientInstanceId,
  type ConfigAssetStore,
  type ConnectionsStore
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { SignInRefusal } from "./refresh";

// The Inbox notice of a Connection whose sign-in the outside system refused: those who may
// connect the Connection again see it beside the requests they decide, because a scheduled
// Workflow would otherwise fail unseen. It is a request of its own kind: approving it only
// acknowledges it, and it ends by itself once someone signed in again. One is pending per
// Connection at a time. It holds the Connection's name and the reason, never a token or what
// a call carried.

/** The approval kind of the notice. */
export const CONNECTION_RECONNECT_NOTICE_KIND = "connection_reconnect";

const payloadSchema = z.object({
  subject: z.object({
    connectionAssetId: z.string().min(1),
    connectionName: z.string().min(1)
  }),
  reason: z.enum(CONNECTION_BINDING_REFUSALS)
});

type ReconnectNoticePayload = z.infer<typeof payloadSchema>;

/** Who files the notice: the platform, never a person. */
const SYSTEM_REQUESTER = { id: "system", displayLabel: "System" };

export interface ConnectionReconnectNoticeDeps {
  clientInstanceId: ClientInstanceId;
  stores: {
    connections: ConnectionsStore;
    approvals: ApprovalRequestStore;
    configAssets: Pick<ConfigAssetStore, "listActiveConfigAssets">;
  };
}

/** Whether the Connection is connected again, or gone: the notice then has nothing to say. */
async function settled(
  deps: ConnectionReconnectNoticeDeps,
  payload: ReconnectNoticePayload
): Promise<boolean> {
  const binding = await deps.stores.connections.getConnectionBinding({
    clientInstanceId: deps.clientInstanceId,
    connectionAssetId: payload.subject.connectionAssetId,
    subject: SHARED_CREDENTIAL_SUBJECT
  });
  return binding === undefined || binding.state !== "needs_reconnect";
}

/** The Connection a notice is about, as the right to connect it again is asked on it. */
function connectionResourceOf(subject: ReconnectNoticePayload["subject"]): AccessResource {
  return {
    kind: CONNECTION_ASSET_KIND,
    name: subject.connectionName,
    assetId: subject.connectionAssetId
  };
}

export function createConnectionReconnectNoticeHandler(
  deps: ConnectionReconnectNoticeDeps
): ApprovalRequestHandler<ReconnectNoticePayload> {
  return {
    kind: CONNECTION_RECONNECT_NOTICE_KIND,
    // Whoever may connect the Connection again sees it: a right held on the Connection, or on
    // a scope the evaluator reads as covering it, as much as one on the instance.
    requiredPermission: CONNECTION_ACTIONS.write,
    resourceOf: (payload) => connectionResourceOf(payload.subject),
    async reviewableSubjects(access) {
      const assets = await deps.stores.configAssets.listActiveConfigAssets({
        clientInstanceId: deps.clientInstanceId,
        kind: CONNECTION_ASSET_KIND
      });
      return assets
        .map((asset) => ({ connectionAssetId: asset.id, connectionName: asset.name }))
        .filter(
          (subject) =>
            access.authorize(CONNECTION_ACTIONS.write, connectionResourceOf(subject)).allowed
        );
    },
    validate: (payload) => payloadSchema.parse(payload),
    preview: async (payload) => ({
      connectionName: payload.subject.connectionName,
      reason: payload.reason
    }),
    async isStale(payload) {
      return (await settled(deps, payload))
        ? { result: { settled: true, connectionName: payload.subject.connectionName } }
        : false;
    },
    // Nothing to apply: whoever decides it read it. The sign-in itself is made on the
    // Connection's page.
    apply: async () => ({ acknowledged: true })
  };
}

/**
 * Files the notice of a refused sign-in, unless one is pending for the Connection already.
 * Two processes that file at the same moment may file two; either ends the same way.
 */
export async function fileConnectionReconnectNotice(
  deps: ConnectionReconnectNoticeDeps,
  refusal: SignInRefusal
): Promise<void> {
  const { connection, reason } = refusal;
  const pending = await deps.stores.approvals.listApprovalRequests({
    clientInstanceId: deps.clientInstanceId,
    kinds: [CONNECTION_RECONNECT_NOTICE_KIND],
    status: "pending",
    subjectContains: { connectionAssetId: connection.assetId },
    page: { limit: 1 }
  });
  if (pending.length > 0) return;
  const payload: ReconnectNoticePayload = {
    subject: { connectionAssetId: connection.assetId, connectionName: connection.config.name },
    reason
  };
  await deps.stores.approvals.createApprovalRequest({
    clientInstanceId: deps.clientInstanceId,
    kind: CONNECTION_RECONNECT_NOTICE_KIND,
    summary: `The Connection '${connection.config.name}' needs a new sign-in: its outside system refused the one it had`,
    payload,
    requestedBy: SYSTEM_REQUESTER
  });
}
