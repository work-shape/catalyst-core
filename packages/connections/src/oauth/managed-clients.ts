import { connectionCallError, type Logger, type SecretResolver } from "@work-shape/catalyst-core";

// The operator's managed OAuth clients (MS-APP-1): apps the operator registered once at a
// provider and declared in release config under `infrastructure.oauthClients`. A catalogue
// part that names one (`managedClient`) installs with no client of its own, and its Connection
// keeps only the client's id in `settings.oauth.managedClient`.
//
// The client secret stays on the host. It is read through the instance's secret provider each
// time a token is exchanged, refreshed or revoked, held for that request only, and is never
// written into the Secret Store, the database, an answer, an event or a log line. A log line
// names the client and the variable, never the value.

/** What a managed client tells the rest of the instance. Public values only. */
export interface ManagedOAuthClient {
  id: string;
  /** The application (client) id: it travels in every authorization address anyway. */
  clientId: string;
  /** Fills the `{tenant}` path segment of the part's endpoints, where it is set. */
  tenant?: string;
}

export interface ManagedOAuthClients {
  /** The client of `id` this instance signs in with, or nothing where it has none. */
  get(id: string): ManagedOAuthClient | undefined;
  /** The client secret of `id`, read from the host now. The caller keeps it for one request. */
  secret(id: string): Promise<string>;
}

/** An instance without managed clients: every part installs with the customer's own app. */
export const NO_MANAGED_OAUTH_CLIENTS: ManagedOAuthClients = Object.freeze({
  get: () => undefined,
  secret: () => Promise.reject(unavailable())
});

function unavailable(): Error {
  return connectionCallError(
    "connection_not_configured",
    "this instance has no managed OAuth client of that id, or its secret is not set on the host"
  );
}

/** One client as release config declares it. */
export interface ManagedOAuthClientDeclaration {
  clientId: string;
  /** The name of the host secret, never its value. */
  credentialSecret: string;
  tenant?: string;
}

/**
 * The managed clients of an instance. A client whose secret the host does not hold is left
 * out with a warning, so its parts fall back to the customer's own app registration instead of
 * offering a Connect that cannot work. The value read for that check is not kept.
 */
export async function createManagedOAuthClients(input: {
  clients: Readonly<Record<string, ManagedOAuthClientDeclaration>>;
  secrets: SecretResolver;
  logger: Pick<Logger, "warn">;
}): Promise<ManagedOAuthClients> {
  const usable = new Map<string, ManagedOAuthClient & { secretName: string }>();
  for (const [id, declared] of Object.entries(input.clients)) {
    try {
      await input.secrets.resolve(declared.credentialSecret);
    } catch {
      input.logger.warn(
        { module: "connections", oauthClient: id, secretName: declared.credentialSecret },
        "The secret of a managed OAuth client is not set on the host. Its catalogue parts ask for the customer's own app registration"
      );
      continue;
    }
    usable.set(id, {
      id,
      clientId: declared.clientId,
      ...(declared.tenant === undefined ? {} : { tenant: declared.tenant }),
      secretName: declared.credentialSecret
    });
  }
  return Object.freeze({
    get(id: string): ManagedOAuthClient | undefined {
      const client = usable.get(id);
      if (client === undefined) return undefined;
      return {
        id: client.id,
        clientId: client.clientId,
        ...(client.tenant === undefined ? {} : { tenant: client.tenant })
      };
    },
    async secret(id: string): Promise<string> {
      const client = usable.get(id);
      if (client === undefined) throw unavailable();
      try {
        return await input.secrets.resolve(client.secretName);
      } catch {
        throw unavailable();
      }
    }
  });
}
