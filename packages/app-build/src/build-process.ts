import { buildPage } from "./bundle";
import { refuseNetwork } from "./no-network";
import type { PageBuildResult } from "./types";
import { decodeWireMessage, encodeWireMessage } from "./wire";

// The entry of the process one build runs in. It reads the Page's files from standard input,
// builds, writes the result to standard output and ends. Its parent, `runPageBuild`, ends it
// when it takes too long or writes too much.

async function main(): Promise<void> {
  refuseNetwork();
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("Standard input is not bytes");
    }
    chunks.push(chunk);
  }
  const request = decodeWireMessage(Buffer.concat(chunks));
  const paths = readPaths(request.head);
  if (paths.length !== request.blobs.length) {
    throw new Error("The request names another number of paths than files");
  }
  const result = await buildPage({
    files: paths.map((path, index) => ({ path, bytes: request.blobs[index] ?? new Uint8Array() }))
  });
  await write(encodeResult(result));
}

function readPaths(head: unknown): string[] {
  if (typeof head !== "object" || head === null || !("paths" in head)) {
    throw new Error("The request names no paths");
  }
  const { paths } = head;
  if (!Array.isArray(paths)) {
    throw new Error("The request names no paths");
  }
  return paths.map((path) => {
    if (typeof path !== "string") throw new Error("A path of the request is not a text");
    return path;
  });
}

function encodeResult(result: PageBuildResult): Uint8Array[] {
  if (result.status === "errors") {
    return encodeWireMessage({ head: result, blobs: [] });
  }
  return encodeWireMessage({
    head: {
      status: result.status,
      manifest: result.manifest,
      kitVersion: result.kitVersion,
      paths: result.files.map((file) => file.path)
    },
    blobs: result.files.map((file) => file.bytes)
  });
}

function write(parts: Uint8Array[]): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(Buffer.concat(parts), (error) => (error ? reject(error) : resolve()));
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
);
