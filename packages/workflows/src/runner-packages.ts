import { AppError, type WorkflowManifest } from "@work-shape/catalyst-core";

/** A Python distribution installed in the release's runner image, not an import name. */
export interface WorkflowRunnerPackage {
  name: string;
  version: string;
}

/** Python distribution names compare without case and with punctuation normalized. */
export function runnerPackageKey(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

/** Declarations record requirements; imports and the sandbox's isolation stay unchanged. */
export function assertWorkflowPackages(
  manifest: Pick<WorkflowManifest, "packages">,
  installed: readonly WorkflowRunnerPackage[]
): void {
  const allowed = new Set(installed.map(({ name }) => runnerPackageKey(name)));
  for (const name of manifest.packages ?? []) {
    if (!allowed.has(runnerPackageKey(name))) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Workflow package '${name}' is not available in the runner image`,
        { reason: "package_not_available", package: name }
      );
    }
  }
}
