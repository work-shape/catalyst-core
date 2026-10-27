/**
 * The bytes of a lossless WebP file of a size, as its header states it, `length` bytes long
 * (even, at least 26). The image data is zeros: the platform reads a picture's header and never
 * decodes it.
 */
export function webp(width: number, height: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(26, length + (length % 2)));
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  view.setUint32(16, bytes.byteLength - 20, true);
  bytes[20] = 0x2f;
  view.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
  return bytes;
}
