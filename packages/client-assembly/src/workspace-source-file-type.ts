/** Bounded signature inspection only: never unpack or execute an uploaded file here. */
export function detectWorkspaceSourceFileType(header: Uint8Array): {
  description: string;
  extension: string;
  mimeType: string;
} {
  const bytes = Buffer.from(header.subarray(0, 8192));
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const ascii = bytes.toString("latin1");
  const type = (description: string, extension: string, mimeType: string) => ({
    description,
    extension,
    mimeType
  });
  if (ascii.startsWith("%PDF-")) return type("PDF document", "pdf", "application/pdf");
  if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))
    return type("7-Zip archive", "7z", "application/x-7z-compressed");
  if (ascii.startsWith("Rar!\x1a\x07")) return type("RAR archive", "rar", "application/vnd.rar");
  if (starts(0x78, 0x9f, 0x3e, 0x22))
    return type("Outlook TNEF attachment (winmail.dat)", "dat", "application/ms-tnef");
  if (
    starts(0x50, 0x4b, 0x03, 0x04) ||
    starts(0x50, 0x4b, 0x05, 0x06) ||
    starts(0x50, 0x4b, 0x07, 0x08)
  ) {
    if (ascii.includes("word/"))
      return type(
        "Word document",
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
    return type("ZIP archive", "zip", "application/zip");
  }
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    if (bytes.toString("utf16le").includes("__properties_version1.0"))
      return type("Outlook message", "msg", "application/vnd.ms-outlook");
    return type("OLE compound document", "bin", "application/x-ole-storage");
  }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return type("PNG image", "png", "image/png");
  if (starts(0xff, 0xd8, 0xff)) return type("JPEG image", "jpg", "image/jpeg");
  if (/^GIF8[79]a/u.test(ascii)) return type("GIF image", "gif", "image/gif");
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP")
    return type("WebP image", "webp", "image/webp");
  if (
    starts(0x49, 0x49, 0x2a, 0) ||
    starts(0x4d, 0x4d, 0, 0x2a) ||
    starts(0x49, 0x49, 0x2b, 0) ||
    starts(0x4d, 0x4d, 0, 0x2b)
  )
    return type("TIFF image", "tiff", "image/tiff");
  if (ascii.startsWith("BM")) return type("BMP image", "bmp", "image/bmp");
  if (ascii.slice(4, 8) === "ftyp") {
    const brands = ascii.slice(8, 64);
    if (/avif|avis/u.test(brands)) return type("AVIF image", "avif", "image/avif");
    if (/heic|heix|hevc|hevx/u.test(brands)) return type("HEIC image", "heic", "image/heic");
    if (/mif1|msf1/u.test(brands)) return type("HEIF image", "heif", "image/heif");
  }
  if (starts(0x1f, 0x8b)) return type("gzip archive", "gz", "application/gzip");
  if (ascii.slice(257, 262) === "ustar") return type("tar archive", "tar", "application/x-tar");
  if (ascii.startsWith("{\\rtf")) return type("Rich Text document", "rtf", "application/rtf");
  // Decode only text-like bytes. A partial final UTF-8 character is normal in a header slice.
  const text = new TextDecoder("utf-8").decode(bytes, { stream: true });
  if (bytes.length > 0 && !/[\x00-\x08\x0e-\x1f]/u.test(text) && !text.includes("\ufffd")) {
    const mail = text.replace(/^\d+\r?\n/u, "");
    if (
      /^(?:[\w-]+:[^\r\n]*\r?\n|[ \t]+[^\r\n]*\r?\n)+/u.test(mail) &&
      /^(?:From|To|Subject|Date|MIME-Version|Received):/imu.test(mail)
    ) {
      return /^\d+\r?\n/u.test(text)
        ? type("Apple Mail message", "emlx", "message/x-emlx")
        : type("Email message", "eml", "message/rfc822");
    }
    return type("Text", "txt", "text/plain");
  }
  return type("unknown binary data", "bin", "application/octet-stream");
}
