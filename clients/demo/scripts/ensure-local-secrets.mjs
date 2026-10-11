import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const secrets = [
  { name: "DEMO_SAMPLE_MCP_KEY", generate: () => randomBytes(32).toString("hex") },
  // The Secret Store reads its key as 32 random bytes in base64.
  { name: "DEMO_SECRET_STORE_KEY", generate: () => randomBytes(32).toString("base64") }
];
const path = process.argv[2] ?? fileURLToPath(new URL("../.env", import.meta.url));

try {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    text = "";
  }
  const generated = [];
  for (const { name, generate } of secrets) {
    const pattern = new RegExp(`^${name}=([^\\r\\n]*)(\\r?)(?=\\n|$)`, "gm");
    const lines = Array.from(text.matchAll(pattern));
    if (lines.some((line) => (line[1] ?? "").length > 0)) continue;
    const value = generate();
    if (lines.length > 0) {
      text = text.replace(pattern, `${name}=${value}$2`);
    } else {
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      text += `${text.length > 0 && !text.endsWith("\n") ? newline : ""}${name}=${value}${newline}`;
    }
    generated.push(name);
  }
  if (generated.length > 0) {
    await writeFile(path, text, { mode: 0o600 });
    for (const name of generated) console.log(`Generated ${name} in .env.`);
  }
} catch {
  console.error(`Could not ensure local secrets: ${secrets.map(({ name }) => name).join(", ")}.`);
  process.exitCode = 1;
}
