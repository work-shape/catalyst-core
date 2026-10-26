import { createHash } from "node:crypto";
import type { WorkflowStepFiles } from "@work-shape/catalyst-workflows";

export function workflowStepFiles(
  paths: readonly string[],
  read: (input: {
    workflow: string;
    revisionId: string;
    path: string;
  }) => Promise<Uint8Array | undefined>
): WorkflowStepFiles {
  return {
    async readTree({ workflow, revisionId }) {
      const revision = { workflow, revisionId };
      const files = (
        await Promise.all(
          paths.map(async (path) => ({ path, content: await read({ ...revision, path }) }))
        )
      ).flatMap((file) =>
        file.content === undefined ? [] : [{ path: file.path, content: file.content }]
      );
      return {
        hash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
        files: files.map((file) => ({ path: file.path, bytes: file.content.byteLength })),
        readFile: async (path) => files.find((file) => file.path === path)?.content
      };
    }
  };
}
