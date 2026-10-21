import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { FIXTURE_SECRET_HANDLE } from "../tests/chat-ui-connection-fixtures";

// Connections of the suite's Connector type `test`, planted in the store as the release seed
// writes them. The type contacts nothing. Every test that plants or creates a Connection takes
// `releaseConnections` (or the same access then Connection turns in a bounded step) until
// cleanup: the list and rights picker are instance-wide, and an API process that starts
// meanwhile deletes Connections no release config names.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const clientInstanceId = "demo-e2e";

async function withSql<Result>(run: (sql: postgres.Sql) => Promise<Result>): Promise<Result> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

/** The one address the suite's release config lets a Connection reach. Nothing listens there. */
export const ALLOWED_URL = "https://127.0.0.1:8443/";

export interface PlantedConnection {
  id: string;
  name: string;
  displayName: string;
  url: string;
  authScheme: "none" | "bearer";
  /**
   * The operations the Connection accepts, where a spec needs other ones than the four that
   * show every state of an operation.
   */
  operations?: readonly {
    name: string;
    effect: "reading" | "changing";
    exposure: readonly string[];
    enabled: boolean;
    /** What the operation is called for people, such as "Load the bookings". */
    title?: string;
  }[];
}

/** Writes one Connection as the store holds it: the asset and its first revision. */
export async function plantConnection(connection: PlantedConnection): Promise<void> {
  const config = {
    name: connection.name,
    displayName: connection.displayName,
    description: "A fixture of the browser suite. It reaches nothing.",
    connectorType: "test",
    ownerPrincipalId: "system",
    settings: { url: connection.url },
    authScheme: connection.authScheme,
    credentialMode: "shared",
    // A reference to a credential in the Secret Store. It is no credential, and no secret is
    // stored under it here.
    ...(connection.authScheme === "bearer" ? { secretHandle: FIXTURE_SECRET_HANDLE } : {}),
    operations: connection.operations ?? [
      { name: "echo", effect: "reading", exposure: ["agent"], enabled: true },
      // Accepted with another description than the type has now: it waits for a review.
      {
        name: "record",
        effect: "changing",
        exposure: [],
        enabled: true,
        schemaFingerprint: "sha256:accepted-before-the-type-changed"
      },
      // The type offers no such operation.
      { name: "removed", effect: "reading", exposure: ["workflow"], enabled: true },
      { name: "echo_off", effect: "reading", exposure: ["agent"], enabled: false }
    ],
    enabled: true,
    origin: "release"
  };
  await plantReleaseAsset({ id: connection.id, kind: "connection", name: connection.name, config });
}

/**
 * Writes one asset of origin `release` as the release seed stores it: the asset and its first
 * revision.
 */
export async function plantReleaseAsset(asset: {
  id: string;
  kind: string;
  name: string;
  config: Parameters<postgres.Sql["json"]>[0];
}): Promise<void> {
  const revisionId = `cfgr_${randomUUID()}`;
  await withSql((sql) =>
    sql.begin(async (tx) => {
      const [state] = await tx<{ version: string }[]>`
        update config_asset_state set version = version + 1, updated_at = now()
        where client_instance_id = ${clientInstanceId}
        returning version`;
      if (!state) {
        throw new Error("The instance has no config asset state");
      }
      await tx`
        insert into config_assets
          (id, client_instance_id, kind, name, scope_kind, status, active_revision_id,
           created_at, updated_at)
        values
          (${asset.id}, ${clientInstanceId}, ${asset.kind}, ${asset.name}, 'instance',
           'active', ${revisionId}, now(), now())`;
      await tx`
        insert into config_asset_revisions
          (id, client_instance_id, asset_id, revision, operation, config, global_version,
           created_at)
        values
          (${revisionId}, ${clientInstanceId}, ${asset.id}, 1, 'create',
           ${tx.json(asset.config)}, ${state.version}, now())`;
    })
  );
}

/** Writes hits of one Guardrail, the newest first, each an hour before the one before it. */
export async function plantGuardrailHits(
  guardrailName: string,
  hits: readonly { outcome: "warn" | "block"; message: string; kind: string }[]
): Promise<void> {
  await withSql(async (sql) => {
    for (const [index, hit] of hits.entries()) {
      await sql`
        insert into guardrail_hits
          (id, client_instance_id, guardrail_name, event, outcome, message, subject_kind,
           created_at)
        values
          (${`ghit_${randomUUID()}`}, ${clientInstanceId}, ${guardrailName},
           'approval_request.before_create', ${hit.outcome}, ${hit.message}, ${hit.kind},
           now() - make_interval(hours => ${index}))`;
    }
  });
}

/** Removes the hits of one Guardrail a spec planted. */
export async function removeGuardrailHits(guardrailName: string): Promise<void> {
  await withSql(
    (sql) =>
      sql`delete from guardrail_hits where client_instance_id = ${clientInstanceId} and guardrail_name = ${guardrailName}`
  );
}

export async function removeConnection(assetId: string): Promise<void> {
  await withSql((sql) => sql`delete from config_assets where id = ${assetId}`);
}

/** Removes a service principal a spec created, with the rows it holds. */
export async function removeServicePrincipal(principalId: string): Promise<void> {
  await withSql(async (sql) => {
    await sql`delete from permission_grants where holder_kind = 'service_principal' and holder_id = ${principalId}`;
    await sql`delete from service_principals where id = ${principalId}`;
  });
}

/** Removes the rows that name one asset, such as the rights a spec gave on a Connection. */
export async function removeGrantsOn(assetId: string): Promise<void> {
  await withSql(
    (sql) => sql`delete from permission_grants where scope_kind = 'asset' and scope_id = ${assetId}`
  );
}
