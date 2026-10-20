import type { ConnectorContext } from "@work-shape/catalyst-core";

interface Entry {
  secret: string;
  revision: number;
  promise: Promise<string>;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}
/** One token lifecycle per connector: concurrent callers join issuance; rotated credentials
 * and revisions never reuse a token. Expiry removes the in-memory token and credential. */
export function createClientCredentialsTokens() {
  const entries = new Map<string, Entry>();
  const forget = (id: string, entry: Entry) => {
    if (entries.get(id) === entry) entries.delete(id);
    clearTimeout(entry.timer);
  };
  return {
    invalidate(context: ConnectorContext) {
      const entry = entries.get(context.connection.id);
      if (entry) forget(context.connection.id, entry);
    },
    async get(
      context: ConnectorContext,
      issue: () => Promise<{ token: string; expiresIn: number }>
    ) {
      const secret = context.credentialFor(context.target)?.secret ?? "";
      const id = context.connection.id;
      let entry = entries.get(id);
      if (
        entry &&
        (entry.secret !== secret ||
          entry.revision !== context.connection.revision ||
          entry.expiresAt <= Date.now())
      ) {
        forget(id, entry);
        entry = undefined;
      }
      if (!entry) {
        const next: Entry = {
          secret,
          revision: context.connection.revision,
          expiresAt: Infinity,
          promise: Promise.resolve("")
        };
        next.promise = issue()
          .then(({ token, expiresIn }) => {
            next.expiresAt = Date.now() + Math.max(0, expiresIn * 1000 - 60_000);
            next.timer = setTimeout(
              () => forget(id, next),
              Math.max(0, next.expiresAt - Date.now())
            );
            next.timer.unref();
            return token;
          })
          .catch((error: unknown) => {
            forget(id, next);
            throw error;
          });
        entries.set(id, next);
        entry = next;
      }
      return entry.promise;
    }
  };
}
