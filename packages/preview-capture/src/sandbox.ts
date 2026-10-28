import { readFile, readlink } from "node:fs/promises";

export interface SandboxEvidence {
  browser: number;
  renderer: number;
  seccomp: number;
  browserUserIsolation: string;
  rendererUserIsolation: string;
}
export async function rendererSandboxEvidence(
  browser: number,
  renderer: number
): Promise<SandboxEvidence> {
  const [cmdline, status, browserUserIsolation, rendererUserIsolation] = await Promise.all([
    readFile(`/proc/${browser}/cmdline`, "utf8"),
    readFile(`/proc/${renderer}/status`, "utf8"),
    readlink(`/proc/${browser}/ns/user`),
    readlink(`/proc/${renderer}/ns/user`)
  ]);
  const seccomp = Number(/^Seccomp:\s+(\d+)$/m.exec(status)?.[1]);
  if (
    cmdline.includes("--no-sandbox") ||
    seccomp !== 2 ||
    browserUserIsolation === rendererUserIsolation
  )
    throw new Error("preview-capture requires Chromium's renderer sandbox");
  return { browser, renderer, seccomp, browserUserIsolation, rendererUserIsolation };
}
