import {
  DocumentSourceError,
  type ConnectorContext,
  type DocumentSourceCapability
} from "@work-shape/catalyst-core";
import { ConnectionCallSlots, connectionCallLimits } from "../call";
import { readConnection, type ConnectionOperationSourceDeps } from "../connection-reads";
import { NO_CREDENTIALS, openConnectorContext } from "../connector-context";

/** Opens the source of an already-authorized ingestion job, through the Connection's
 * credential, egress and call limits. The publishing principal is SRC-1b's gate. */
export function createDocumentSourceOpener(
  deps: ConnectionOperationSourceDeps,
  slots: ConnectionCallSlots
) {
  return async (
    name: string,
    parent: AbortSignal
  ): Promise<{ capability: DocumentSourceCapability; context: ConnectorContext }> => {
    const stored = await readConnection(deps, name);
    if (!stored?.config.enabled || !stored.type?.documentSource)
      throw new DocumentSourceError("unavailable", "The document source is unavailable");
    const limits = connectionCallLimits(stored.type);
    const signal = AbortSignal.any([parent, AbortSignal.timeout(limits.callTimeoutMs)]);
    const context = await openConnectorContext({
      type: stored.type,
      connection: { id: stored.assetId, revision: stored.revision, config: stored.config },
      egress: deps.egress,
      credentials: deps.credentials ?? NO_CREDENTIALS,
      signal
    });
    const current = await readConnection(deps, name);
    signal.throwIfAborted();
    if (
      !current?.config.enabled ||
      current.assetId !== stored.assetId ||
      current.revision !== stored.revision
    )
      throw new DocumentSourceError("unauthorized", "The document source changed while opening it");
    const source = stored.type.documentSource;
    const connectionAssetId = stored.assetId;
    async function request<T>(call: () => Promise<T>): Promise<T> {
      const { release } = await slots.acquire(connectionAssetId, limits, signal);
      let abort: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new DocumentSourceError("unavailable", "The source call timed out"));
          signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        return await Promise.race([call(), aborted]);
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
        release();
      }
    }
    const capability: DocumentSourceCapability = {
      list: (input, ctx) => request(() => source.list(input, ctx)),
      changes: (input, ctx) => request(() => source.changes(input, ctx)),
      async *fetch(input, ctx) {
        const { release } = await slots.acquire(connectionAssetId, limits, signal);
        const iterator = source.fetch(input, ctx)[Symbol.asyncIterator]();
        let abort: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () =>
            reject(new DocumentSourceError("unavailable", "The source stream timed out"));
          signal.addEventListener("abort", abort, { once: true });
        });
        try {
          for (;;) {
            signal.throwIfAborted();
            const next = await Promise.race([iterator.next(), aborted]);
            if (next.done) break;
            yield next.value;
          }
        } finally {
          if (abort) signal.removeEventListener("abort", abort);
          // An adapter that ignores abort must not hold the caller's slot while closing.
          const closing = iterator.return?.();
          if (closing) await Promise.race([closing, aborted]).catch(() => undefined);
          release();
        }
      }
    };
    return { capability, context };
  };
}
