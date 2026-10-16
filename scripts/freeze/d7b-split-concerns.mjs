#!/usr/bin/env node
// Replay D7b after D1 and D3. Run from the platform root on their unsplit sources, then apply
// the separate hand-fix commit. Extraction keeps function bodies and query text in source.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const touched = new Set();
const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, source) => {
  fs.writeFileSync(file, source);
  touched.add(file);
};
const parse = (file, source = read(file)) =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const editsApplied = (source, edits) => {
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, start) + text + source.slice(end);
  return source;
};
const statementNames = (node) =>
  ts.isVariableStatement(node)
    ? node.declarationList.declarations.map((declaration) => declaration.name.getText())
    : node.name && ts.isIdentifier(node.name)
      ? [node.name.text]
      : [];
const exported = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const typeOnly = (node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);

// A concern owns the declarations assigned to it. Follow real symbols, not identifier text:
// property names and shadowed locals must not become imports or extra public exports.
function split(file, concerns) {
  const program = ts.createProgram([file], { target: ts.ScriptTarget.Latest, noResolve: true });
  const source = program.getSourceFile(file);
  const checker = program.getTypeChecker();
  const imports = source.statements
    .filter(ts.isImportDeclaration)
    .map((n) => n.getFullText().trim());
  const groups = new Map([[".", []], ...Object.keys(concerns).map((name) => [name, []])]);
  const owners = new Map();
  const nodes = source.statements.filter((node) => !ts.isImportDeclaration(node));
  for (const node of nodes) {
    const names = statementNames(node);
    const group =
      Object.entries(concerns).find(([, selected]) =>
        names.some((n) => selected.includes(n))
      )?.[0] ?? ".";
    groups.get(group).push(node);
    for (const name of names) {
      const declaration = ts.isVariableStatement(node)
        ? node.declarationList.declarations.find((d) => d.name.getText() === name)
        : node;
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (symbol) owners.set(symbol, { group, name, node });
    }
  }
  for (const [group, selected] of Object.entries(concerns))
    for (const name of selected)
      if (!groups.get(group).some((node) => statementNames(node).includes(name)))
        throw new Error(`${file}: declaration ${name} missing; refuse partial replay`);
  const needs = new Map([...groups.keys()].map((group) => [group, new Map()]));
  for (const [group, statements] of groups) {
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const owner = owners.get(checker.getSymbolAtLocation(node));
        if (owner && owner.group !== group) needs.get(group).set(owner.name, owner);
      }
      ts.forEachChild(node, visit);
    };
    statements.forEach(visit);
  }
  const exposed = new Set();
  for (const dependencies of needs.values())
    for (const owner of dependencies.values()) exposed.add(owner.name);
  for (const [group, statements] of groups) {
    let body = statements
      .map((node) => {
        let text = node.getFullText();
        if (group !== "." && !exported(node) && statementNames(node).some((n) => exposed.has(n))) {
          const start = node.getStart(source) - node.getFullStart();
          text = text.slice(0, start) + "export " + text.slice(start);
        }
        return text;
      })
      .join("\n");
    const dependencies = [...needs.get(group).values()];
    for (const dependencyGroup of new Set(dependencies.map((d) => d.group))) {
      const specifier =
        dependencyGroup === "." ? `./${path.basename(file, ".ts")}` : `./${dependencyGroup}`;
      const entries = dependencies
        .filter((d) => d.group === dependencyGroup)
        .map((d) => `${typeOnly(d.node) ? "type " : ""}${d.name}`);
      body = `import { ${entries.join(", ")} } from ${JSON.stringify(specifier)};\n` + body;
    }
    if (group === ".") {
      for (const [movedGroup, moved] of groups) {
        if (movedGroup === ".") continue;
        const publicNodes = moved.filter(exported);
        if (publicNodes.length)
          body += `\nexport { ${publicNodes.flatMap((node) => statementNames(node).map((name) => `${typeOnly(node) ? "type " : ""}${name}`)).join(", ")} } from "./${movedGroup}";\n`;
      }
    }
    write(
      group === "." ? file : path.join(path.dirname(file), `${group}.ts`),
      imports.join("\n") + "\n" + body
    );
  }
}

// Lift a class method into a function with explicit dependencies. The original method keeps
// its signature and delegates, preserving even the private members in the emitted class d.ts.
function liftMethods(file, className, selected, transform, prefixFor, argumentFor) {
  const source = parse(file);
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name.text === className
  );
  if (!declaration) throw new Error(`${file}: ${className} missing`);
  const edits = [];
  const functions = [];
  for (const name of selected) {
    const method = declaration.members.find(
      (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name
    );
    if (!method?.body) throw new Error(`${file}: ${name} missing`);
    const parameters = method.parameters.map((p) => p.getText(source));
    const args = method.parameters.map((p) => p.name.getText(source));
    const typeParameters = method.typeParameters?.length
      ? `<${method.typeParameters.map((p) => p.getText(source)).join(", ")}>`
      : "";
    const returnType = method.type ? `: ${method.type.getText(source)}` : "";
    const isAsync = method.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const prefix = prefixFor(name);
    const functionBody = transform(method.body.getText(source), name);
    const comment = read(file).slice(method.getFullStart(), method.getStart(source)).trim();
    functions.push(
      `${comment}\n${isAsync ? "async " : ""}function ${name}${typeParameters}(${[...prefix, ...parameters].join(", ")})${returnType} ${functionBody}`
    );
    edits.push({
      start: method.body.getStart(source),
      end: method.body.end,
      text: `{ return ${name}(${[...argumentFor(name), ...args].join(", ")}); }`
    });
  }
  write(file, editsApplied(read(file), edits) + "\n" + functions.join("\n\n") + "\n");
}

const config = "packages/config-schema/src/schemas.ts";
split(config, {
  "auth-schema": [
    "userIdentitySchema",
    "defaultDevelopmentUser",
    "developmentAuthConfigSchema",
    "standaloneSeedUserSchema",
    "standaloneAuthConfigSchema",
    "UserIdentityConfig",
    "StandaloneSeedUserConfig"
  ],
  "usage-schema": [
    "usageBudgetConfigSchema",
    "usageSafeguardsConfigSchema",
    "usageRateCardTokenRatesShape",
    "usageRateCardConfigSchema",
    "usageCostConfigSchema"
  ],
  "runtime-schema": [
    "conversationTitleConfigSchema",
    "agentRuntimeConfigSchema",
    "modelContextConfigSchema",
    "REMOVED_WEB_SEARCH_KEYS",
    "webSearchConfigSchema",
    "webAccessConfigSchema",
    "workflowsConfigSchema",
    "executionWorkspacesConfigSchema"
  ]
});
// Theme literals deliberately stay in schemas.ts: its ui-guard allowance stays byte-identical.

const execution = "packages/postgres-store/src/postgres-execution-workspace-operations.ts";
split(execution, {
  "postgres-execution-workspace-metadata": [
    "ensureExecutionWorkspace",
    "getExecutionWorkspace",
    "getExecutionWorkspaceForConversation",
    "findExecutionWorkspaceOfActiveConversation",
    "requireActiveConversation",
    "requireActiveWorkspace"
  ],
  "postgres-execution-workspace-files": [
    "upsertWorkspaceFile",
    "deleteWorkspaceFile",
    "listWorkspaceFiles",
    "getWorkspaceFile"
  ],
  "postgres-workspace-command-operations": [
    "enqueueWorkspaceCommand",
    "getWorkspaceCommand",
    "countActiveWorkspaceCommands",
    "claimWorkspaceCommand",
    "renewClaimedWorkspaceCommandLease",
    "listWorkspaceCommandsWithoutJob",
    "leaseExpiry",
    "completeWorkspaceCommand",
    "failWorkspaceCommand",
    "requestWorkspaceCommandCancellation",
    "giveUpUnclaimedWorkspaceCommand",
    "RUN_ENDED_REASON",
    "withdrawUnclaimedWorkspaceCommandsOfRuns",
    "hasUnclaimedWorkspaceCommand",
    "withdrawCommandJobs",
    "cancelClaimedWorkspaceCommand",
    "claimedCommandWhere"
  ],
  "postgres-execution-workspace-cleanup": [
    "listExecutionWorkspaceCleanupTargets",
    "listExecutionWorkspaceObjectsForDeletion",
    "markExecutionWorkspaceDeleted",
    "collectExecutionWorkspaceDeletionSummary"
  ],
  "postgres-workspace-file-metadata": [
    "uniqueStrings",
    "workspaceFileMetadataForUpsert",
    "workspaceFileMetadataWithRetainedObjectKey",
    "preserveRetainedObjectKeys",
    "retainedObjectKeys"
  ]
});

const files = "packages/postgres-store/src/postgres-file-store.ts";
const attachmentMethods = [
  "createConversationAttachment",
  "getConversationAttachment",
  "listDraftAttachments",
  "listSentConversationAttachments",
  "findConversationAttachmentByChecksum",
  "updateConversationAttachment",
  "reactivateDraftAttachment",
  "deleteDraftAttachment",
  "claimReadyDraftAttachmentsForMessage",
  "claimConversationAttachmentForPreprocessing",
  "renewClaimedConversationAttachmentLease",
  "listConversationAttachmentsWithoutJob",
  "completeClaimedConversationAttachment",
  "failClaimedConversationAttachment",
  "findReadyConversationAttachmentByFile",
  "findConversationAttachmentByFile"
];
liftMethods(
  files,
  "PostgresPlatformFileStore",
  attachmentMethods,
  (body) => body.replaceAll("this.db", "db").replaceAll("this.callbacks", "callbacks"),
  (name) => [
    "db: PostgresConnection",
    ...(name === "deleteDraftAttachment" ? ["callbacks: PostgresPlatformFileStoreCallbacks"] : [])
  ],
  (name) => ["this.db", ...(name === "deleteDraftAttachment" ? ["this.callbacks"] : [])]
);
const cleanupMethods = [
  "markConversationManagedObjectsDeleted",
  "listConversationManagedObjectsForDeletion",
  "listConversationsPendingObjectCleanup"
];
liftMethods(
  files,
  "PostgresPlatformFileStore",
  cleanupMethods,
  (body) => body.replaceAll("this.db", "db"),
  () => ["db: PostgresConnection"],
  () => ["this.db"]
);
split(files, {
  "postgres-conversation-attachment-operations": [...attachmentMethods, "leaseExpiry"],
  "postgres-managed-object-cleanup": [
    ...cleanupMethods,
    "collectConversationManagedObjectsForDeletion",
    "uniqueStrings"
  ],
  "postgres-file-store-types": ["PostgresConnection", "PostgresPlatformFileStoreCallbacks"]
});

const workspace = "packages/chat-server/src/workspaces/collaboration-workspace-service.ts";
const requestMethods = [
  "browseDirectory",
  "requestAccess",
  "listAccessRequests",
  "approveAccessRequestNow",
  "declineAccessRequest"
];
const requestDependencies = {
  browseDirectory: ["options"],
  requestAccess: ["options", "requireDiscoverableWorkspace", "record"],
  listAccessRequests: ["options", "requireWorkspaceAccess"],
  approveAccessRequestNow: ["options", "requireRole", "requireSharedWorkspace", "record"],
  declineAccessRequest: ["options", "requireRole", "record"]
};
liftMethods(
  workspace,
  "CollaborationWorkspaceWorkflow",
  requestMethods,
  (body) => body.replaceAll("this.", "context."),
  (name) => [
    `context: Pick<WorkspaceAccessRequestContext, ${requestDependencies[name].map((key) => JSON.stringify(key)).join(" | ")}>`
  ],
  (name) => [
    `{ ${requestDependencies[name].map((key) => `${key}: this.${key}${key === "options" ? "" : ".bind(this)"}`).join(", ")} }`
  ]
);
write(
  workspace,
  read(workspace) +
    `
interface WorkspaceAccessRequestContext {
  options: ChatServerOptions;
  requireWorkspaceAccess(user: AuthenticatedUser, collaborationWorkspaceId: CollaborationWorkspaceId): Promise<WorkspaceAccess>;
  requireDiscoverableWorkspace(collaborationWorkspaceId: CollaborationWorkspaceId): Promise<void>;
  requireSharedWorkspace(collaborationWorkspaceId: CollaborationWorkspaceId): Promise<CollaborationWorkspace>;
  requireRole(call: WorkspaceChangeCall, collaborationWorkspaceId: CollaborationWorkspaceId, needed: WorkspaceRoleNeeded): Promise<WorkspaceAccess>;
  record(call: WorkspaceChangeCall, collaborationWorkspaceId: CollaborationWorkspaceId, type: string, metadata?: Record<string, string | string[]>): Promise<void>;
}
`
);
split(workspace, {
  "workspace-service-types": [
    "WorkspaceRoleNeeded",
    "WorkspaceChangeCall",
    "WorkspaceListItem",
    "WorkspaceDirectoryItem",
    "WorkspaceMemberItem",
    "WorkspaceAccessRequestItem",
    "WorkspaceDeletionImpact",
    "CreateSharedWorkspaceCommand",
    "UpdateWorkspaceSettingsCommand"
  ],
  "workspace-access-requests": [...requestMethods, "WorkspaceAccessRequestContext"],
  "workspace-service-access": [
    "CANNOT_ADD_MEMBER_MESSAGE",
    "roleRefusal",
    "requireOwnerOrAdmin",
    "requireOwner",
    "authorizationOf",
    "refusalError",
    "requireNoRefusal"
  ],
  "workspace-settings": [
    "MAX_WORKSPACE_NAME_LENGTH",
    "MAX_WORKSPACE_DESCRIPTION_LENGTH",
    "MAX_WORKSPACE_EMOJI_LENGTH",
    "normalizeRequiredName",
    "normalizeDescription",
    "normalizeEmoji",
    "validateAccentColor",
    "workspaceChangedFields"
  ]
});

const runner = "packages/tool-execution/src/workspace-command-runner.ts";
const filesystemMethods = [
  "hydrateWorkspace",
  "ensureStandardWorkspaceDirectories",
  "scanWorkspaceFiles"
];
liftMethods(
  runner,
  "LocalWorkspaceCommandRunner",
  filesystemMethods,
  (body, name) => {
    if (name === "hydrateWorkspace") {
      body = body.replaceAll("this.", "context.");
    } else if (name === "scanWorkspaceFiles")
      body = body.replaceAll("this.maxPathLength", "maxPathLength");
    return body;
  },
  (name) =>
    name === "hydrateWorkspace"
      ? ["context: WorkspaceCommandFileContext"]
      : name === "scanWorkspaceFiles"
        ? ["maxPathLength: number"]
        : [],
  (name) =>
    name === "hydrateWorkspace"
      ? [
          "{ store: this.store, byteStore: this.byteStore, workerId: this.workerId, tempRootDirectory: this.tempRootDirectory, maxPathLength: this.maxPathLength, reuseWorkspaceDirectories: this.reuseWorkspaceDirectories, ensureStandardWorkspaceDirectories: this.ensureStandardWorkspaceDirectories.bind(this), scanWorkspaceFiles: this.scanWorkspaceFiles.bind(this) }"
        ]
      : name === "scanWorkspaceFiles"
        ? ["this.maxPathLength"]
        : []
);
write(
  runner,
  read(runner) +
    `\ninterface WorkspaceCommandFileContext {
  store: Pick<PlatformStores, "files" | "executionWorkspaces">;
  byteStore: ObjectStorage;
  workerId: string;
  tempRootDirectory: string;
  maxPathLength: number;
  reuseWorkspaceDirectories: boolean;
  ensureStandardWorkspaceDirectories(workspaceDirectory: string): Promise<void>;
  scanWorkspaceFiles(workspaceDirectory: string, command: WorkspaceCommand): Promise<ScannedWorkspaceFile[]>;
}\n`
);
split(runner, {
  "workspace-command-files": [
    ...filesystemMethods,
    "WorkspaceCommandFileContext",
    "HydratedWorkspace",
    "ScannedWorkspaceFile",
    "cachedWorkspaceDirectoryName",
    "setsEqual",
    "inferWorkspaceMimeType",
    "DEFAULT_WORKSPACE_BYTES",
    "STANDARD_WORKSPACE_DIRECTORIES"
  ],
  "workspace-command-errors": [
    "WorkspaceRunnerFailure",
    "workspaceCommandError",
    "toWorkspaceCommandError"
  ]
});

// TypeScript's organizer removes imports no longer used by each concern, without printing or
// rewriting any moved body. In particular it removes the original package-wide import sets.
const options = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler
};
const host = {
  getScriptFileNames: () => [...touched],
  getScriptVersion: () => "0",
  getScriptSnapshot: (file) =>
    fs.existsSync(file) ? ts.ScriptSnapshot.fromString(read(file)) : undefined,
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => options,
  getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory
};
const service = ts.createLanguageService(host);
for (const file of [...touched]) {
  const edits = service.organizeImports({ type: "file", fileName: file }, {}, {});
  for (const change of edits)
    fs.writeFileSync(
      change.fileName,
      editsApplied(
        read(change.fileName),
        change.textChanges.map((change) => ({
          start: change.span.start,
          end: change.span.start + change.span.length,
          text: change.newText
        }))
      )
    );
}
service.dispose();
console.log(`Split ${touched.size} files; format these files, then apply the hand-fix commit.`);
console.log([...touched].join("\n"));
