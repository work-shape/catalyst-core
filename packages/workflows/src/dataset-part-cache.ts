import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { ObjectStorage, WorkflowDatasetPart } from "@work-shape/catalyst-core";

/** One immutable part per engine, bounded by the writer's part size, never by dataset size.
 * Sequential loop items must not decompress and scan their entire prefix on every row.
 * Authorization and live metadata are still checked by the caller on every read.
 */
export function createDatasetPartCache(objects: ObjectStorage, maxBytes: number, rowBytes: number) {
  let held: { scope: string; key: string; hash: string; lines: readonly string[] } | undefined;
  return async (
    part: WorkflowDatasetPart,
    scope: string | undefined,
    signal: AbortSignal | undefined,
    invalid: () => Error
  ): Promise<readonly string[] | undefined> => {
    if (scope === undefined || part.bytes > maxBytes) return undefined; // Large paged parts keep the streaming path.
    signal?.throwIfAborted();
    if (held?.scope === scope && held.key === part.key && held.hash === part.hash)
      return held.lines;
    const object = await objects.get(part.key);
    signal?.throwIfAborted();
    const source = Readable.from(object.body);
    const stream = source.pipe(createGunzip());
    const stop = () => {
      source.destroy();
      stream.destroy();
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const buffers: Buffer[] = [];
      let bytes = 0;
      const chunks: AsyncIterable<unknown> = stream;
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) throw invalid();
        bytes += chunk.length;
        if (bytes > part.bytes) throw invalid();
        buffers.push(Buffer.from(chunk));
      }
      signal?.throwIfAborted();
      const data = Buffer.concat(buffers);
      if (
        bytes !== part.bytes ||
        createHash("sha256").update(data).digest("hex") !== part.hash ||
        data.at(-1) !== 10
      )
        throw invalid();
      const lines = data.toString("utf8").split("\n");
      lines.pop();
      if (
        lines.length !== part.rows ||
        lines.some((line) => Buffer.byteLength(line) + 1 > rowBytes)
      )
        throw invalid();
      held = { scope, key: part.key, hash: part.hash, lines };
      return lines;
    } finally {
      signal?.removeEventListener("abort", stop);
      stop();
    }
  };
}
