import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentFileFormat, DocumentPreprocessingConfig } from "@vivd-catalyst/core";

export interface ConvertDocumentInput {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
  format: DocumentFileFormat;
}

export interface ConvertDocumentOutput {
  text: string;
}

export interface DocumentTextConverter {
  convert(input: ConvertDocumentInput): Promise<ConvertDocumentOutput>;
}

export class MarkItDownDocumentTextConverter implements DocumentTextConverter {
  private readonly config: DocumentPreprocessingConfig;

  constructor(config: DocumentPreprocessingConfig) {
    this.config = config;
  }

  async convert(input: ConvertDocumentInput): Promise<ConvertDocumentOutput> {
    if (input.format === "txt" || input.format === "md") {
      return {
        text: decodeUtf8(input.bytes)
      };
    }

    const directory = await mkdtemp(path.join(tmpdir(), "vivd-doc-"));
    const inputPath = path.join(directory, sanitizeTempFilename(input.filename));
    await writeFile(inputPath, input.bytes);
    try {
      const args = createConverterArgs(this.config.converterArgs, inputPath);
      const text = await runCommand({
        command: this.config.converterCommand,
        args,
        timeoutMs: this.config.timeoutMs
      });
      return {
        text
      };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function createConverterArgs(configuredArgs: readonly string[], inputPath: string): string[] {
  if (configuredArgs.length === 0) {
    return [inputPath];
  }
  const hasInputPlaceholder = configuredArgs.some((arg) => arg.includes("{input}"));
  const args = configuredArgs.map((arg) => arg.replaceAll("{input}", inputPath));
  return hasInputPlaceholder ? args : [...args, inputPath];
}

function sanitizeTempFilename(filename: string): string {
  const basename = path.basename(filename).replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
  return basename.length > 0 ? basename : "document";
}

function isMissingCommandError(error: unknown, command: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const codedError = error as Error & { code?: unknown; path?: unknown };
  return (
    codedError.code === "ENOENT" &&
    (typeof codedError.path !== "string" || codedError.path === command || path.basename(codedError.path) === command)
  );
}

function runCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Document conversion timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (isMissingCommandError(error, input.command)) {
        reject(
          new Error(
            `Document converter command '${input.command}' was not found on PATH. Install the converter or configure documents.preprocessing.converterCommand.`
          )
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const errorText = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(errorText || `Document converter exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
