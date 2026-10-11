import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NAME_RULE,
  CONNECTION_REFUSALS,
  defineAssetKind,
  findConnectorTypeIssues,
  type ConnectorTypeRegistry
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./shared";

export interface ConnectionAssetKindOptions {
  /** The Connector types of this build. A Connection of another type is refused. */
  connectorTypes: ConnectorTypeRegistry;
}

/**
 * The refusal of every write of a Connection through the asset operations. Until runtime
 * authoring a Connection is written by the release seed alone, which writes to the store and
 * through no operation.
 */
function runtimeAuthoringUnavailable(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    `${CONNECTION_REFUSALS.runtimeAuthoringUnavailable}: a Connection is defined in release config. It cannot be created, changed or deleted here yet`,
    { reason: CONNECTION_REFUSALS.runtimeAuthoringUnavailable }
  );
}

/**
 * The Connection kind: the access to one outside system. Its revision holds settings, accepted
 * operations and a handle of the Secret Store, never a secret. A validated write is live: the
 * kind has no draft. It is no part of the release bundle and offered in no workspace list.
 */
export function createConnectionAssetKind(options: ConnectionAssetKindOptions): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: CONNECTION_ASSET_KIND,
      plural: "connections",
      schema: connectionConfigSchema,
      nameRule: {
        pattern: CONNECTION_NAME_PATTERN,
        maxLength: CONNECTION_NAME_MAX_LENGTH,
        description: CONNECTION_NAME_RULE
      },
      actions: {
        read: CONNECTION_ACTIONS.read,
        write: CONNECTION_ACTIONS.write,
        delete: CONNECTION_ACTIONS.delete
      },
      // A Connection refers to no other asset.
      validate: () => [],
      // Asked for the Connections a write adds or changes only: a stored Connection of a type
      // a later release no longer ships never stands in the way of a write to another asset.
      validateWrite(context, connections) {
        const changed = connections.filter((connection) =>
          context.changes(CONNECTION_ASSET_KIND, connection.name)
        );
        const issues = changed.flatMap((connection) =>
          findConnectorTypeIssues(options.connectorTypes, connection)
        );
        if (issues.length === 0 && changed.length > 0) {
          throw runtimeAuthoringUnavailable();
        }
        return issues;
      },
      summarize: (connection) => ({
        name: connection.name,
        title: connection.displayName,
        ...(connection.description === undefined ? {} : { description: connection.description }),
        attributes: {
          connectorType: connection.connectorType,
          origin: connection.origin,
          enabled: connection.enabled
        }
      })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    // A write that leaves the definition as it is stored changes nothing the check above
    // sees, and a revert is a write too: both are refused here.
    assertInteractiveUpsertAllowed() {
      throw runtimeAuthoringUnavailable();
    },
    assertInteractiveDeleteAllowed() {
      throw runtimeAuthoringUnavailable();
    }
  };
}
