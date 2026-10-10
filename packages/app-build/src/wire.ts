// How the build process and its parent hand files to each other: one message per direction,
// a JSON head followed by the bytes of the files. The head names the length of each file.

const HEAD_LENGTH_BYTES = 4;

export interface WireMessage<Head> {
  head: Head;
  blobs: Uint8Array[];
}

export function encodeWireMessage<Head>(message: WireMessage<Head>): Uint8Array[] {
  const head = new TextEncoder().encode(
    JSON.stringify({ head: message.head, lengths: message.blobs.map((blob) => blob.byteLength) })
  );
  const length = new Uint8Array(HEAD_LENGTH_BYTES);
  new DataView(length.buffer).setUint32(0, head.byteLength);
  return [length, head, ...message.blobs];
}

/** Reads a message. Throws when the bytes are not one whole message. */
export function decodeWireMessage(bytes: Uint8Array): WireMessage<unknown> {
  if (bytes.byteLength < HEAD_LENGTH_BYTES) {
    throw new Error("The message has no head");
  }
  const headLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const headEnd = HEAD_LENGTH_BYTES + headLength;
  if (headEnd > bytes.byteLength) {
    throw new Error("The message ends inside its head");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(HEAD_LENGTH_BYTES, headEnd))
  );
  if (typeof parsed !== "object" || parsed === null || !("head" in parsed)) {
    throw new Error("The message head is not an object");
  }
  const lengths = "lengths" in parsed && Array.isArray(parsed.lengths) ? parsed.lengths : [];
  const blobs: Uint8Array[] = [];
  let offset = headEnd;
  for (const length of lengths) {
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
      throw new Error("The message names a length that is not a size");
    }
    if (offset + length > bytes.byteLength) {
      throw new Error("The message ends inside a file");
    }
    blobs.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.byteLength) {
    throw new Error("The message holds more bytes than its head names");
  }
  return { head: parsed.head, blobs };
}
