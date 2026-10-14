import {
  createAgentAssetKind,
  createAppAssetKind,
  createConnectionAssetKind,
  createGuardrailAssetKind,
  createSkillAssetKind,
  type WorkflowAssetKind
} from "@vivd-catalyst/chat-server";
import { createAssetKindRegistry, type ModuleSnapshot } from "@vivd-catalyst/core";
import type { InstanceConnections } from "./connections";

/**
 * Every asset kind of this build. A later kind is one more registration in this list; a
 * module's kinds come with its assembly.
 */
export function createInstanceAssetKinds(input: {
  agent: Parameters<typeof createAgentAssetKind>[0];
  skill: Parameters<typeof createSkillAssetKind>[0];
  connections: InstanceConnections | undefined;
  modules: ModuleSnapshot;
  moduleKinds: readonly WorkflowAssetKind[];
}) {
  return createAssetKindRegistry([
    createAgentAssetKind(input.agent),
    createSkillAssetKind(input.skill),
    ...(input.connections ? [createConnectionAssetKind(input.connections)] : []),
    createGuardrailAssetKind(),
    ...(input.modules.isEnabled("apps") ? [createAppAssetKind()] : []),
    ...input.moduleKinds
  ]);
}
