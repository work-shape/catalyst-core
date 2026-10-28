import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyRequest } from "fastify";
import { AppError, type OperationUpload } from "@work-shape/catalyst-core";
import type { UploadFileContent } from "../conversations/attachments";

/**
 * The one `file` part of a multipart request, or nothing where the request has none. With
 * `cutAfterBytes` a larger file is not refused here: it arrives cut after that many bytes, so
 * that the operation it is for refuses it as too large with its own reason.
 */
export async function readMultipartFile(request: FastifyRequest, cutAfterBytes?: number) {
  try {
    return await request.file(
      cutAfterBytes === undefined
        ? undefined
        : { limits: { fileSize: cutAfterBytes }, throwFileSizeLimit: false }
    );
  } catch {
    // Parser failures describe untrusted bytes, so never expose the parser's message.
    throw new AppError("BAD_REQUEST", "The multipart upload cannot be read");
  }
}

/** A received file, written to a directory of its own until `cleanup` removes it. */
export interface StagedUpload {
  content: UploadFileContent;
  /** Every byte of the file. */
  read(): Promise<Uint8Array>;
  cleanup(): Promise<void>;
}

/**
 * Writes a received file to a temporary directory while it counts its bytes and its checksum,
 * so that nothing is stored before the whole body arrived. The caller removes it with `cleanup`.
 */
export async function stageMultipartFile(stream: NodeJS.ReadableStream): Promise<StagedUpload> {
  const directory = await mkdtemp(join(tmpdir(), "vivd-catalyst-upload-"));
  const path = join(directory, "upload");
  const checksum = createHash("sha256");
  let byteSize = 0;
  let header = Buffer.alloc(0);
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      checksum.update(bytes);
      if (header.byteLength < 8192) {
        header = Buffer.concat([header, bytes.subarray(0, 8192 - header.byteLength)]);
      }
      callback(null, bytes);
    }
  });
  try {
    await pipeline(stream, inspect, createWriteStream(path));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    content: {
      byteSize,
      checksum: checksum.digest("hex"),
      headerBytes: header,
      openStream: () => createReadStream(path)
    },
    read: async () => new Uint8Array(await readFile(path)),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

/** Receives the one file of a multipart call of a per-resource route. */
export async function stageOperationUpload(
  request: FastifyRequest,
  uploadLimitBytes?: number
): Promise<{ upload: OperationUpload; cleanup(): Promise<void> }> {
  const part = await readMultipartFile(
    request,
    uploadLimitBytes === undefined ? undefined : uploadLimitBytes + 1
  );
  if (!part) throw new AppError("VALIDATION_FAILED", "A file upload is required");
  const staged = await stageMultipartFile(part.file);
  return {
    upload: {
      filename: part.filename,
      ...(part.mimetype ? { mimeType: part.mimetype } : {}),
      byteSize: staged.content.byteSize,
      sha256: staged.content.checksum,
      read: staged.read
    },
    cleanup: staged.cleanup
  };
}
