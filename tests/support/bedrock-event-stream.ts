import { crc32 } from "node:zlib";

/**
 * Writes messages in Bedrock's stream framing (`application/vnd.amazon.eventstream`) for tests.
 * It is written from AWS's description of the format and shares no code with the adapter's
 * reader, so a mistake in one does not hide in the other.
 */
export function bedrockEventStreamMessage(
  headers: Record<string, string>,
  payload: Uint8Array
): Uint8Array {
  const encoder = new TextEncoder();
  const encodedHeaders = Buffer.concat(
    Object.entries(headers).map(([name, value]) => {
      const nameBytes = encoder.encode(name);
      const valueBytes = encoder.encode(value);
      const header = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);
      header.writeUInt8(nameBytes.length, 0);
      header.set(nameBytes, 1);
      // Header value type 7: a string with a two-byte length.
      header.writeUInt8(7, 1 + nameBytes.length);
      header.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
      header.set(valueBytes, 4 + nameBytes.length);
      return header;
    })
  );
  const total = 12 + encodedHeaders.length + payload.length + 4;
  const message = Buffer.alloc(total);
  message.writeUInt32BE(total, 0);
  message.writeUInt32BE(encodedHeaders.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  message.set(encodedHeaders, 12);
  message.set(payload, 12 + encodedHeaders.length);
  message.writeUInt32BE(crc32(message.subarray(0, total - 4)), total - 4);
  return message;
}

/** One event of an answer as Bedrock sends it: a `chunk` whose `bytes` hold the event's JSON. */
export function bedrockChunk(event: unknown): Uint8Array {
  return bedrockEventStreamMessage(
    { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
    new TextEncoder().encode(
      JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), "utf8").toString("base64") })
    )
  );
}

/** A failure Bedrock reports inside a stream that had begun. */
export function bedrockStreamException(type: string, message: string): Uint8Array {
  return bedrockEventStreamMessage(
    { ":exception-type": type, ":content-type": "application/json", ":message-type": "exception" },
    new TextEncoder().encode(JSON.stringify({ message }))
  );
}
