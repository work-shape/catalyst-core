import type { WorkflowRunnerPackage } from "../../runner-packages";

/** The Python packages a code step may declare: those of the runner image. */
export function runnerPackagesSection(packages: readonly WorkflowRunnerPackage[]): string {
  return `## Runner package allow-list

${packages.length === 0 ? "No runner package manifest is available: the allow-list is empty, so publish refuses every declared package." : packages.map(({ name, version }) => `- \`${name}\` (${version})`).join("\n")}

Use distribution names here: \`python-docx\` imports as \`docx\`, \`Pillow\` as \`PIL\`.
Packages are installed and pinned when the release image is built. Nothing is installed at
publish or run time, and the container has no network. Imports are not restricted to declared
packages. Adding a package requires a runner image release. There is no package-count cap.`;
}
