import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  convertOfficeDocument,
  inspectPdf,
  NativeProcessError,
  renderPdfPage,
  runNativeProcess
} from "@vivd-catalyst/document-execution";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("native document execution", () => {
  it("bounds process output and reports failed processes without shell interpolation", async () => {
    const result = await runNativeProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(70000))"],
      timeoutMs: 1_000
    });
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024);

    await expect(
      runNativeProcess({
        command: process.execPath,
        args: ["-e", "process.stderr.write('conversion failed'); process.exit(7)"],
        timeoutMs: 1_000
      })
    ).rejects.toMatchObject({
      reason: "process_failed",
      exitCode: 7,
      stderr: "conversion failed"
    });

    await expect(
      runNativeProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it.skipIf(process.platform === "win32")("terminates the process group when aborted", async () => {
    const directory = await temporaryDirectory("native-process-group-");
    const marker = join(directory, "grandchild-finished");
    const ready = join(directory, "parent-ready");
    const childScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 250)`)}], { stdio: 'ignore' });`,
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`,
      "setInterval(() => undefined, 1000);"
    ].join("\n");
    const controller = new AbortController();

    const running = runNativeProcess({
      command: process.execPath,
      args: ["-e", childScript],
      timeoutMs: 2_000,
      signal: controller.signal
    });
    await waitForFile(ready);
    controller.abort();
    await expect(running).rejects.toMatchObject({ reason: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("isolates LibreOffice profiles and returns only non-empty converted output", async () => {
    const directory = await temporaryDirectory("office-conversion-");
    const outputDirectory = join(directory, "output");
    await mkdir(outputDirectory);
    const sourcePath = join(outputDirectory, "proposal.docx");
    await writeFile(sourcePath, "source");
    await writeFile(join(outputDirectory, "aaa-stale.pdf"), "stale");
    const command = await writeExecutable(
      directory,
      "fake-office",
      String.raw`
const { basename, extname, join } = require("node:path");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const outdir = args[args.indexOf("--outdir") + 1];
const format = args[args.indexOf("--convert-to") + 1];
const source = args.at(-1);
const profile = args.find((arg) => arg.startsWith("-env:UserInstallation=file:"));
if (!profile || !process.env.HOME.includes(".catalyst-office-profile-")) process.exit(9);
writeFileSync(join(outdir, basename(source, extname(source)) + "." + format), "converted");
process.stdout.write("converted");
`
    );

    const result = await convertOfficeDocument({
      command,
      sourcePath,
      outputDirectory,
      outputFormat: "pdf",
      timeoutMs: 1_000
    });

    expect(result.stdout).toBe("converted");
    expect(result.outputPath).toBe(join(outputDirectory, "proposal.pdf"));
    expect(await readFile(result.outputPath!, "utf8")).toBe("converted");
    expect(
      (await readdir(outputDirectory)).some((entry) =>
        entry.startsWith(".catalyst-office-operation-")
      )
    ).toBe(false);
  });

  it("does not return stale office output when conversion produces no file", async () => {
    const directory = await temporaryDirectory("office-no-output-");
    const outputDirectory = join(directory, "output");
    await mkdir(outputDirectory);
    const sourcePath = join(outputDirectory, "proposal.docx");
    const staleOutput = join(outputDirectory, "proposal.pdf");
    await writeFile(sourcePath, "source");
    await writeFile(staleOutput, "stale");
    const command = await writeExecutable(
      directory,
      "fake-office-no-output",
      `process.stdout.write("no output");`
    );

    await expect(
      convertOfficeDocument({
        command,
        sourcePath,
        outputDirectory,
        outputFormat: "pdf",
        timeoutMs: 1_000
      })
    ).resolves.toEqual({ stdout: "no output" });
    expect(await readFile(staleOutput, "utf8")).toBe("stale");
    expect(
      (await readdir(outputDirectory)).some((entry) =>
        entry.startsWith(".catalyst-office-operation-")
      )
    ).toBe(false);
  });

  it("parses PDF metadata and renders exactly one selected page", async () => {
    const directory = await temporaryDirectory("pdf-native-tools-");
    const pdfPath = join(directory, "source.pdf");
    await writeFile(pdfPath, "%PDF fixture");
    const infoCommand = await writeExecutable(
      directory,
      "fake-pdfinfo",
      String.raw`
process.stdout.write("Pages:          12\nPage    3 size: 612 x 792 pts\n");
`
    );
    const renderCommand = await writeExecutable(
      directory,
      "fake-pdftoppm",
      String.raw`
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[args.indexOf("-f") + 1] !== "3" || args[args.indexOf("-l") + 1] !== "3") process.exit(8);
writeFileSync(args.at(-1) + ".png", Buffer.from("rendered page"));
`
    );

    await expect(
      inspectPdf({
        command: infoCommand,
        pdfPath,
        pageNumber: 3,
        timeoutMs: 1_000
      })
    ).resolves.toEqual({
      pageCount: 12,
      pageSize: { widthPoints: 612, heightPoints: 792 }
    });
    await expect(
      renderPdfPage({
        command: renderCommand,
        pdfPath,
        outputDirectory: directory,
        pageNumber: 3,
        resolution: { maxLongEdgePixels: 2400 },
        timeoutMs: 1_000
      })
    ).resolves.toEqual(Buffer.from("rendered page"));
    expect((await readdir(directory)).some((entry) => entry.endsWith(".png"))).toBe(false);
  });

  it("rejects stale render output when the renderer produces no file", async () => {
    const directory = await temporaryDirectory("pdf-render-no-output-");
    const pdfPath = join(directory, "source.pdf");
    const staleOutput = join(directory, "page-3.png");
    await writeFile(pdfPath, "%PDF fixture");
    await writeFile(staleOutput, "stale");
    const command = await writeExecutable(directory, "fake-pdftoppm-no-output", "");

    await expect(
      renderPdfPage({
        command,
        pdfPath,
        outputDirectory: directory,
        pageNumber: 3,
        resolution: { dpi: 160 },
        timeoutMs: 1_000
      })
    ).rejects.toThrow();
    expect(await readFile(staleOutput, "utf8")).toBe("stale");
    expect(
      (await readdir(directory)).some((entry) => entry.startsWith(".catalyst-pdf-render-"))
    ).toBe(false);
  });

  it("uses a typed error when a native command is unavailable", async () => {
    const error = await runNativeProcess({
      command: `missing-native-command-${Date.now()}`,
      args: [],
      timeoutMs: 1_000
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeProcessError);
    expect(error).toMatchObject({ reason: "command_missing", cause: expect.any(Error) });
    expect((error as Error).message).toContain("ENOENT");
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function writeExecutable(directory: string, name: string, source: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
