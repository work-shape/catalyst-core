import { readFileSync } from "node:fs";
// Stay below GitHub's 125,000-character body limit; longer notes link to the full changelog.
const RELEASE_NOTES_MAX_BYTES = 120_000;

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(version ?? ""))
  throw new Error("Invalid release version");
const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`## ${version} — `));
if (start < 0) throw new Error(`CHANGELOG.md has no ${version} section; cut the release first`);
let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
if (end < 0) end = lines.length;
const notes = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
const bytes = Buffer.from(notes);
if (bytes.length + 1 <= RELEASE_NOTES_MAX_BYTES) {
  console.log(notes);
} else {
  const footer = `\n\n… Notes truncated. [Full changelog](https://github.com/work-shape/catalyst-core/blob/v${version}/CHANGELOG.md).\n`;
  let end = RELEASE_NOTES_MAX_BYTES - Buffer.byteLength(footer);
  // Keep the prefix valid UTF-8 even when the byte budget ends inside a character.
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  process.stdout.write(bytes.subarray(0, end).toString("utf8").trimEnd() + footer);
}
