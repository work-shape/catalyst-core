import { expect, it } from "vitest";
import { detectWorkspaceSourceFileType } from "@work-shape/catalyst-client-assembly";

it.each([
  [Buffer.from("PK\x03\x04"), "ZIP archive"],
  [Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), "7-Zip archive"],
  [Buffer.from("Rar!\x1a\x07\x01\x00"), "RAR archive"],
  [Buffer.from([0x78, 0x9f, 0x3e, 0x22]), "Outlook TNEF attachment (winmail.dat)"],
  [Buffer.from("From: sender@example.invalid\nSubject: Synthetic\n\nHello"), "Email message"],
  [
    Buffer.from("42\nFrom: sender@example.invalid\nSubject: Synthetic\n\nHello"),
    "Apple Mail message"
  ],
  [Buffer.from("%PDF-1.7"), "PDF document"],
  [Buffer.from([0xff, 0xd8, 0xff]), "JPEG image"],
  [Buffer.from("II\x2a\x00"), "TIFF image"],
  [Buffer.from("MM\x00\x2a"), "TIFF image"],
  [Buffer.from("BM\x00\x00"), "BMP image"],
  [Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1"), "HEIC image"],
  [Buffer.from("\x00\x00\x00\x18ftypmif1"), "HEIF image"],
  [Buffer.from([0, 0xff, 0xfe, 0x13]), "unknown binary data"],
  [Buffer.from("hello"), "Text"],
  [Buffer.from("3\nhello"), "Text"]
])("describes bytes without a filename or browser MIME type (%s)", (bytes, description) => {
  expect(detectWorkspaceSourceFileType(bytes).description).toBe(description);
});
