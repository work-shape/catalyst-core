import { AppError } from "@work-shape/catalyst-core";
import { ModelProviderError, toModelTransportFailure } from "../model-provider-error";
import { MODEL_STREAM_IDLE_TIMEOUT_MS } from "../openai-compatible-stream";

/**
 * The framing of a streamed Bedrock answer (`application/vnd.amazon.eventstream`). A message is
 * a prelude of two lengths and their checksum, headers, a payload and a checksum of the whole
 * message; all numbers are big-endian. Nothing outside the adapter reads it.
 */
export interface BedrockEventStreamMessage {
  /** The string headers, such as `:message-type` and `:event-type`. Others are left out. */
  headers: Record<string, string>;
  payload: Uint8Array;
}

const PRELUDE_BYTES = 12;
const CHECKSUM_BYTES = 4;
// Protects the process from a length field that is wrong or hostile: no message of the stream
// is larger than AWS allows (16 MiB of payload and 128 KiB of headers). Past it the call fails
// as an invalid response.
const EVENT_STREAM_MESSAGE_MAX_BYTES = 16 * 1024 * 1024 + 128 * 1024 + PRELUDE_BYTES + 4;

/** The size of a header value by its type, where the type has a fixed one. */
const FIXED_HEADER_VALUE_BYTES: Record<number, number> = {
  0: 0, // true
  1: 0, // false
  2: 1, // byte
  3: 2, // short
  4: 4, // integer
  5: 8, // long
  8: 8, // timestamp
  9: 16 // uuid
};
const HEADER_TYPE_BYTES = 6;
const HEADER_TYPE_STRING = 7;

/** The messages of a response body, read under the idle limit of every model stream. */
export async function* readBedrockEventStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<BedrockEventStreamMessage> {
  const reader = body.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await readWithinIdleLimit(reader);
      if (done) {
        ended = true;
        break;
      }
      buffered = buffered.byteLength === 0 ? value : concat(buffered, value);
      for (;;) {
        const length = completeMessageLength(buffered);
        if (length === undefined) break;
        yield decodeMessage(buffered.subarray(0, length));
        buffered = buffered.subarray(length);
      }
    }
    if (buffered.byteLength > 0) {
      // The connection closed in the middle of a message: the answer is incomplete.
      throw new AppError("TIMEOUT", "Model provider stream ended in the middle of a message");
    }
  } finally {
    // A consumer that stops reading, or fails, leaves a response the provider still writes.
    // Cancelling the body ends the request, so the provider stops generating.
    if (!ended) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

async function readWithinIdleLimit(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          // Not sent again: three attempts would keep a user waiting for half an hour on a
          // provider that answers nothing, so one idle limit bounds the whole call.
          new ModelProviderError({
            kind: "timeout",
            retryable: false,
            message: "Model provider stream sent no data for 10 minutes"
          })
        ),
      MODEL_STREAM_IDLE_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    // The stream was cut while it was read, or the caller stopped it.
    throw toModelTransportFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/** The length of the first message when all of it has arrived. */
function completeMessageLength(buffered: Uint8Array): number | undefined {
  if (buffered.byteLength < PRELUDE_BYTES) {
    return undefined;
  }
  const view = viewOf(buffered);
  const total = view.getUint32(0);
  const headers = view.getUint32(4);
  if (
    view.getUint32(8) !== crc32(buffered.subarray(0, 8)) ||
    total > EVENT_STREAM_MESSAGE_MAX_BYTES ||
    total < PRELUDE_BYTES + headers + CHECKSUM_BYTES
  ) {
    throw malformed();
  }
  return buffered.byteLength >= total ? total : undefined;
}

function decodeMessage(message: Uint8Array): BedrockEventStreamMessage {
  try {
    return readMessage(message);
  } catch {
    // A length inside the message points outside it.
    throw malformed();
  }
}

function readMessage(message: Uint8Array): BedrockEventStreamMessage {
  const view = viewOf(message);
  const bodyEnd = message.byteLength - CHECKSUM_BYTES;
  if (view.getUint32(bodyEnd) !== crc32(message.subarray(0, bodyEnd))) {
    throw malformed();
  }
  const headersEnd = PRELUDE_BYTES + view.getUint32(4);
  const decoder = new TextDecoder();
  const headers: Record<string, string> = {};
  let offset = PRELUDE_BYTES;
  while (offset < headersEnd) {
    const nameLength = view.getUint8(offset);
    const name = decoder.decode(message.subarray(offset + 1, offset + 1 + nameLength));
    offset += 1 + nameLength;
    const type = view.getUint8(offset);
    offset += 1;
    if (type === HEADER_TYPE_STRING || type === HEADER_TYPE_BYTES) {
      const valueLength = view.getUint16(offset);
      offset += 2;
      if (type === HEADER_TYPE_STRING) {
        headers[name] = decoder.decode(message.subarray(offset, offset + valueLength));
      }
      offset += valueLength;
    } else {
      const valueLength = FIXED_HEADER_VALUE_BYTES[type];
      if (valueLength === undefined) {
        throw malformed();
      }
      offset += valueLength;
    }
    if (offset > headersEnd) {
      throw malformed();
    }
  }
  return { headers, payload: message.subarray(headersEnd, bodyEnd) };
}

function malformed(): ModelProviderError {
  return new ModelProviderError({
    kind: "invalid_response",
    message: "Model provider returned a malformed stream"
  });
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first, 0);
  joined.set(second, first.byteLength);
  return joined;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** The CRC-32 (IEEE) of the event stream's checksums. */
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
