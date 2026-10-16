import { readFileSync } from "node:fs";
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(version ?? ""))
  throw new Error("Invalid release version");
const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`## ${version} — `));
if (start < 0) throw new Error(`CHANGELOG.md has no ${version} section; cut the release first`);
let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
if (end < 0) end = lines.length;
console.log(
  lines
    .slice(start + 1, end)
    .join("\n")
    .trim()
);
