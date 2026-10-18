import {
  AppError,
  asUserId,
  isAuthenticatedServicePrincipal,
  getSubjectUserId,
  connectionCallError,
  type AuthenticatedIdentity,
  type ConnectionPersonContextSubject,
  type AuditActor
} from "@work-shape/catalyst-core";
import { readConnection, type ConnectionOperationSourceDeps } from "./connection-reads";
import { connectionOriginOf } from "./connector-context";

type Deps = Pick<ConnectionOperationSourceDeps, "clientInstanceId" | "stores" | "connectorTypes">;

/** Kept apart from OAuth subjects, and from every other identity kind. */
function subjectOf(subject: ConnectionPersonContextSubject): string {
  return `person_context:${subject.subjectKind}:${subject.subjectId}`;
}

/** One indexed read per outgoing attempt; never inherits an admin's or parent's value. */
export async function resolveConnectionPersonContext(
  deps: Pick<Deps, "clientInstanceId" | "stores">,
  connectionAssetId: string,
  header: string,
  origin: string,
  actor: AuthenticatedIdentity | undefined
): Promise<string> {
  if (actor === undefined || actor.clientInstanceId !== deps.clientInstanceId)
    throw connectionCallError("person_context_unmapped");
  const binding = await deps.stores.connections.getConnectionPersonContext({
    clientInstanceId: deps.clientInstanceId,
    connectionAssetId,
    subject: subjectOf({
      subjectKind: isAuthenticatedServicePrincipal(actor) ? "service_principal" : "user",
      subjectId: isAuthenticatedServicePrincipal(actor) ? actor.id : getSubjectUserId(actor)
    })
  });
  if (
    !binding ||
    binding.header !== header ||
    binding.origin !== origin ||
    binding.value === null
  ) {
    throw connectionCallError("person_context_unmapped");
  }
  return binding.value;
}

export interface ConnectionPersonContextView extends ConnectionPersonContextSubject {
  value?: string;
  rowVersion: number | null;
}

export function createConnectionPersonContextManagement(deps: Deps) {
  async function get(
    name: string,
    subject: ConnectionPersonContextSubject
  ): Promise<ConnectionPersonContextView> {
    const { connection, header, origin } = await configuredPersonContext(deps, name);
    const binding = await deps.stores.connections.getConnectionPersonContext({
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: connection.assetId,
      subject: subjectOf(subject)
    });
    return {
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      ...(binding &&
      binding.header === header &&
      binding.origin === origin &&
      binding.value !== null
        ? { value: binding.value }
        : {}),
      rowVersion: binding?.rowVersion ?? null
    };
  }
  return {
    getPersonContext: get,
    async setPersonContext(
      name: string,
      input: ConnectionPersonContextSubject & {
        value: string | null;
        expectedRowVersion: number | null;
      },
      audit: { actor: AuditActor; correlationId: string }
    ): Promise<ConnectionPersonContextView> {
      return deps.stores.transaction(async (stores) => {
        const tx = { ...deps, stores };
        const { connection, header, origin } = await configuredPersonContext(tx, name);
        // Only identities of this instance may be mapped. Principals are explicit, never a user's fallback.
        const exists =
          input.subjectKind === "user"
            ? await stores.users.getUser({
                clientInstanceId: deps.clientInstanceId,
                userId: asUserId(input.subjectId)
              })
            : (
                await stores.apiAccess.listServicePrincipals({
                  clientInstanceId: deps.clientInstanceId
                })
              ).find((principal) => principal.id === input.subjectId);
        if (!exists) throw new AppError("NOT_FOUND", "The mapping subject does not exist");
        const written = await stores.connections.setConnectionPersonContext({
          clientInstanceId: deps.clientInstanceId,
          connectionAssetId: connection.assetId,
          subject: subjectOf(input),
          header,
          origin,
          value: input.value,
          expectedRowVersion: input.expectedRowVersion,
          changedBy: audit.actor.userId ?? audit.actor.principalId ?? "system"
        });
        if (!written)
          throw new AppError("CONFLICT", "The person context changed; read it again before saving");
        await stores.audit.appendAuditEvent({
          clientInstanceId: deps.clientInstanceId,
          type: "connection.person_context_set",
          status: "success",
          ...audit,
          subject: connection.assetId,
          metadata: {
            connectionName: name,
            subjectKind: input.subjectKind,
            subjectId: input.subjectId,
            mapped: input.value !== null
          }
        });
        return createConnectionPersonContextManagement(tx).getPersonContext(name, input);
      });
    }
  };
}

async function configuredPersonContext(deps: Deps, name: string) {
  const connection = await readConnection(deps, name, { held: true });
  if (!connection) throw new AppError("NOT_FOUND", "The Connection does not exist");
  const { type, config } = connection;
  const parsed = type?.settingsSchema.safeParse(config.settings);
  const header = parsed?.success ? type?.personContextHeaderName?.(parsed.data) : undefined;
  const origin = type ? connectionOriginOf(type, config) : undefined;
  if (header === undefined || origin === undefined)
    throw connectionCallError("connection_not_configured");
  return { connection, header, origin };
}
