#!/usr/bin/env node
// Run from platform after D2. Commit this replay together with its generated files;
// apply the separate workspace-action extraction commit after rerunning on main.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import ts from "typescript";

const expectedHashes = {
  "packages/chat-ui/src/chat/workspace/workspace-chat-model.ts":
    "4946afb6e04ca908c4064194c401bc1a8438692ca5f9b746272e8da90f8ad158",
  "packages/chat-ui/src/chat/tools/tool-call.tsx":
    "dfff51114a90a8d122cb97a02794df1894b162573513e27a9bade53c2fdae6b9",
  "packages/chat-ui/src/chat/assistant/assistant-ui-adapter.ts":
    "a42eb34da207f9398b6d575b1a763e848ad8b198d9720f780433163c3fe1d687"
};
const staged = new Map();

function split(path, groups, additions = "") {
  const source = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== expectedHashes[path]) {
    throw new Error(
      `D7c refuses changed input: ${path}. Reconcile the extraction before replaying.`
    );
  }
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports = ast.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.getText(ast))
    .join("\n");
  const namesOf = (node) =>
    ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((item) => item.name.getText(ast))
      : node.name
        ? [node.name.getText(ast)]
        : [];
  const statements = new Map(
    ast.statements.flatMap((node) => namesOf(node).map((name) => [name, node]))
  );
  const moved = new Set();
  const links = additions;
  for (const { file, names, expose = [], extra = "" } of groups) {
    const target = join(dirname(path), file);
    if (existsSync(target)) throw new Error(`D7c refuses existing output: ${target}`);
    const selected = names.map((name) => {
      const node = statements.get(name);
      if (!node || moved.has(node))
        throw new Error(`D7c cannot uniquely extract ${name} from ${path}`);
      moved.add(node);
      let text = source.slice(node.getFullStart(), node.end).trim();
      if (
        expose.includes(name) &&
        !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        // Keep a declaration's leading comments with it.
        const start = node.getStart(ast) - node.getFullStart();
        const full = source.slice(node.getFullStart(), node.end);
        text = `${full.slice(0, start)}export ${full.slice(start)}`.trim();
      }
      return text;
    });
    staged.set(target, `${imports}\n${extra}\n\n${selected.join("\n\n")}\n`);
  }
  let remaining = source;
  for (const node of [...moved].sort((a, b) => b.pos - a.pos)) {
    remaining = remaining.slice(0, node.getFullStart()) + remaining.slice(node.end);
  }
  staged.set(path, `${links}\n${remaining}`);
}

const workspace = "packages/chat-ui/src/chat/workspace/workspace-chat-model.ts";
const workspaceTypes = [
  "WorkspaceChatModelInput",
  "WorkspaceChatModel",
  "WorkflowsModel",
  "AgentsModel",
  "AppsModel",
  "WorkspaceAuthModel",
  "WorkspaceConfigModel",
  "OwnSettingsPage",
  "WorkspaceRouteModel",
  "WorkspaceChromeModel",
  "ConversationRailModel",
  "SelectedChatModel",
  "ToolDisplayModel"
];
// Keep only type entry points that callers use. Re-exporting the six already-unused
// component-model types duplicates their Knip findings after the split.
const workspaceEntryTypes = ["WorkspaceChatModelInput", "WorkspaceChatModel", "SelectedChatModel"];
const state = [
  "WORKSPACE_AUTH_SCOPE",
  "workspaceScopedConfigFor",
  "isAbandonedDraftConversation",
  "activeAgentNameFor",
  "RUN_NOT_STARTED_CODE",
  "RUN_TOOL_SILENT_CODE",
  "RUN_COMMAND_NOT_TAKEN_CODE",
  "MODEL_NOT_PRICED_CODE",
  "terminalRunNotice"
];
split(
  workspace,
  [
    { file: "workspace-chat-types.ts", names: workspaceTypes },
    { file: "workspace-chat-state.ts", names: state }
  ],
  `import type { WorkspaceChatModelInput, WorkspaceChatModel } from "./workspace-chat-types";
export type { ${workspaceEntryTypes.join(", ")} } from "./workspace-chat-types";
import { WORKSPACE_AUTH_SCOPE, workspaceScopedConfigFor, isAbandonedDraftConversation, activeAgentNameFor, terminalRunNotice } from "./workspace-chat-state";
export { WORKSPACE_AUTH_SCOPE, workspaceScopedConfigFor, isAbandonedDraftConversation, activeAgentNameFor, terminalRunNotice } from "./workspace-chat-state";`
);

const tool = "packages/chat-ui/src/chat/tools/tool-call.tsx";
const presentation = [
  "SidePanelToolCall",
  "SidePanelDataPart",
  "DisplayToolCall",
  "DisplayDataPart",
  "ToolUiState",
  "NAME_MARK",
  "CONNECTION_SENTENCES",
  "ToolCallHead",
  "ConnectionCallLine",
  "ToolCallFoldLabel",
  "ToolStatusIcon",
  "CompactToolCall",
  "ToolDetailDisclosure",
  "ToolDetails"
];
const projection = [
  "toolStatusLabel",
  "toolUiState",
  "toolDetailSections",
  "readToolDetailSections",
  "readToolActionLabel",
  "readToolDisplayProjection",
  "TOOL_TITLES_BY_LOCALE",
  "TOOL_NAME_ACRONYMS",
  "readTranslatedToolTitle",
  "readToolSubjectLabel",
  "readSkillSubjectLabel",
  "readDisplayProvidedTitle",
  "readRecordString",
  "readTrimmedString",
  "humanizeToolName",
  "isWorkspaceToolName",
  "readErrorSentence",
  "formatDetails",
  "getToolSummary",
  "getWorkspaceCommandSummary",
  "isRecord",
  "hasRenderedNode"
];
split(
  tool,
  [
    {
      file: "tool-call-presentation.tsx",
      names: presentation,
      expose: [
        "SidePanelToolCall",
        "SidePanelDataPart",
        "DisplayToolCall",
        "DisplayDataPart",
        "CompactToolCall",
        "ToolCallHead"
      ],
      extra: 'import { toolUiState } from "./tool-call-projection";'
    },
    {
      file: "tool-call-projection.ts",
      names: projection,
      expose: [
        "toolStatusLabel",
        "toolUiState",
        "toolDetailSections",
        "getToolSummary",
        "hasRenderedNode",
        "formatDetails"
      ]
    }
  ],
  `import { SidePanelToolCall, SidePanelDataPart, DisplayToolCall, DisplayDataPart, CompactToolCall, ToolCallHead } from "./tool-call-presentation";
export { ToolCallFoldLabel } from "./tool-call-presentation";
import { toolStatusLabel, toolUiState, toolDetailSections, readToolDisplayProjection, getToolSummary, hasRenderedNode, formatDetails } from "./tool-call-projection";
export { readToolDetailSections, readToolActionLabel, readToolDisplayProjection } from "./tool-call-projection";`
);

const adapter = "packages/chat-ui/src/chat/assistant/assistant-ui-adapter.ts";
const adapterTypes = [
  "AssistantUiActiveRun",
  "AssistantUiMessageCustomMetadata",
  "AssistantUiApprovalDecision",
  "AssistantUiMessageMetadata"
];
const parts = [
  "UiMessagePartProjectionOptions",
  "toAttachmentFilePart",
  "toActiveRunUiMessage",
  "isTerminalRunStatus",
  "toProjectionUiMessageParts",
  "activeRunPartsWithTextFallback",
  "legacyActiveRunParts",
  "toToolCallUiPart",
  "terminalToolErrorForActiveRun",
  "toAssistantToolState",
  "toUiMessageParts",
  "appendWorkspacePromotedSurfacesPart",
  "appendWorkspacePromotedArtifactsPart",
  "appendAssistantWebSourceParts",
  "appendSyntheticWebSearchToolPart",
  "createWebSourceProviderMetadata",
  "readUserAttachmentFileParts"
];
split(
  adapter,
  [
    { file: "assistant-ui-types.ts", names: adapterTypes },
    {
      file: "assistant-ui-parts.ts",
      names: parts,
      expose: [
        "toActiveRunUiMessage",
        "toProjectionUiMessageParts",
        "toUiMessageParts",
        "appendWorkspacePromotedSurfacesPart",
        "appendWorkspacePromotedArtifactsPart",
        "appendAssistantWebSourceParts"
      ],
      extra:
        'import type { AssistantUiActiveRun, AssistantUiMessageMetadata } from "./assistant-ui-types";'
    }
  ],
  `import type { ${adapterTypes.join(", ")} } from "./assistant-ui-types";
export type { ${adapterTypes.join(", ")} } from "./assistant-ui-types";
import { toActiveRunUiMessage, toProjectionUiMessageParts, toUiMessageParts, appendWorkspacePromotedSurfacesPart, appendWorkspacePromotedArtifactsPart, appendAssistantWebSourceParts } from "./assistant-ui-parts";
export { toAttachmentFilePart } from "./assistant-ui-parts";`
);

// The six raw controls and one font-size finding travel with their unchanged JSX.
const baselinePath = "tests/ui-guard.baseline.json";
const baseline = readFileSync(baselinePath, "utf8");
if (!baseline.includes('"packages/chat-ui/src/chat/tools/tool-call.tsx":'))
  throw new Error("D7c UI baseline input changed");
staged.set(
  baselinePath,
  baseline.replace(
    '"packages/chat-ui/src/chat/tools/tool-call.tsx":',
    '"packages/chat-ui/src/chat/tools/tool-call-presentation.tsx":'
  )
);

// TypeScript removes only unused imports, then sorts the remaining imports. Bodies stay verbatim.
const host = {
  getScriptFileNames: () =>
    [...staged.keys()].filter((file) => file.endsWith(".ts") || file.endsWith(".tsx")),
  getScriptVersion: () => "0",
  getScriptSnapshot: (file) => {
    const source = staged.get(file) ?? ts.sys.readFile(file);
    return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
  },
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX
  }),
  getDefaultLibFileName: ts.getDefaultLibFilePath,
  fileExists: (file) => staged.has(file) || ts.sys.fileExists(file),
  readFile: (file) => staged.get(file) ?? ts.sys.readFile(file),
  readDirectory: ts.sys.readDirectory
};
const service = ts.createLanguageService(host);
for (const file of host.getScriptFileNames()) {
  let source = staged.get(file);
  const edits = service.organizeImports(
    { type: "file", fileName: file },
    { indentSize: 2, newLineCharacter: "\n" },
    {}
  );
  for (const edit of edits
    .flatMap((entry) => entry.textChanges)
    .sort((a, b) => b.span.start - a.span.start)) {
    source =
      source.slice(0, edit.span.start) +
      edit.newText +
      source.slice(edit.span.start + edit.span.length);
  }
  staged.set(file, source);
}
service.dispose();
for (const [path, source] of staged) writeFileSync(path, source);
console.log(
  `D7c extracted three chat concerns into ${staged.size} files. Format the changed files before committing.`
);
