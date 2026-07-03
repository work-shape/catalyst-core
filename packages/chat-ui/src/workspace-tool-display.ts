export interface ToolDetailSection {
  label: string;
  value: string;
}

export interface WorkspaceToolDisplayProjection {
  actionLabel: string;
  summary?: string;
  sections: ToolDetailSection[];
}

const MAX_LISTED_NAMES = 3;
const MAX_COMMAND_PARTS = 8;
const MAX_FAILURE_PREVIEW_CHARS = 1800;
const MAX_FAILURE_STRING_CHARS = 320;
const MAX_FAILURE_JSON_DEPTH = 4;
const MAX_FAILURE_JSON_ARRAY_ITEMS = 6;
const MAX_FAILURE_JSON_OBJECT_FIELDS = 16;

export function projectWorkspaceToolDisplay(input: {
  args: unknown;
  result: unknown;
  toolName: string;
}): WorkspaceToolDisplayProjection | undefined {
  if (!input.toolName.startsWith("workspace.")) {
    return undefined;
  }

  switch (input.toolName) {
    case "workspace.exec":
      return projectWorkspaceExec(input.args, input.result);
    case "workspace.import_files":
      return projectWorkspaceImport(input.result);
    case "workspace.read_file":
      return projectWorkspaceReadFile(input.args, input.result);
    case "workspace.promote_artifact":
      return projectWorkspacePromoteArtifact(input.args, input.result);
    case "workspace.list_files":
      return projectWorkspaceListFiles(input.result);
    default:
      return projectGenericWorkspaceTool(input.toolName, input.result);
  }
}

export function isFailedWorkspaceExecResult(input: {
  result: unknown;
  toolName: string;
}): boolean {
  if (input.toolName !== "workspace.exec") {
    return false;
  }
  const output = readOutput(input.result);
  return readString(output?.status) === "failed";
}

export function readWorkspaceToolErrorText(input: {
  result: unknown;
  toolName: string;
}): string | undefined {
  return isFailedWorkspaceExecResult(input) ? "Workspace command failed" : undefined;
}

export function summarizeWorkspaceCommand(command: string): string | undefined {
  if (isMultilineCommand(command)) {
    return "workspace script";
  }
  const tokens = tokenizeCommand(readCommandSummaryLine(command));
  if (tokens.length === 0) {
    return undefined;
  }

  const commandPrefix = readCommandPrefix(tokens);
  if (!commandPrefix) {
    return undefined;
  }

  const parts = [...commandPrefix.parts];
  for (let index = commandPrefix.nextIndex; index < tokens.length && parts.length < MAX_COMMAND_PARTS; index += 1) {
    const token = tokens[index];
    if (!token || isShellBoundaryToken(token)) {
      break;
    }
    if (!token.startsWith("-") || !isSafeFlagToken(token)) {
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const flag = token.slice(0, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      parts.push(isSafeCommandValue(value) && flagAllowsDisplayedValue(flag) ? `${flag}=${value}` : flag);
      continue;
    }

    parts.push(token);
    const next = tokens[index + 1];
    if (
      next &&
      !next.startsWith("-") &&
      isSafeCommandValue(next) &&
      flagAllowsDisplayedValue(token) &&
      parts.length < MAX_COMMAND_PARTS
    ) {
      parts.push(next);
      index += 1;
    }
  }

  return parts.join(" ");
}

function isMultilineCommand(command: string): boolean {
  return command
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#")).length > 1;
}

function readCommandSummaryLine(command: string): string {
  const lines = command
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const firstOperationalLine = lines.find((line) => !isShellSetupLine(line));
  return firstOperationalLine ?? command.trim();
}

function isShellSetupLine(line: string): boolean {
  return /^set\s+[-+][A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+)*$/u.test(line);
}

function projectWorkspaceExec(args: unknown, result: unknown): WorkspaceToolDisplayProjection {
  const input = isRecord(args) ? args : undefined;
  const container = isRecord(result) ? result : undefined;
  const output = isRecord(container?.output) ? container.output : undefined;
  const command = typeof input?.command === "string" ? summarizeWorkspaceCommand(input.command) : undefined;
  const status = readString(output?.status) ?? readString(container?.status);
  const exitCode = readNumber(output?.exitCode);
  const durationMs = readNumber(output?.durationMs);
  const stdoutBytes = byteLength(readString(output?.stdoutPreview) ?? "");
  const stderrBytes = byteLength(readString(output?.stderrPreview) ?? "");
  const truncated = isRecord(output?.truncated) ? output.truncated : undefined;
  const changedFiles = readRecords(output?.changedFiles);
  const promotedArtifacts = readRecords(output?.promotedArtifacts);
  const error = isRecord(container?.error) ? container.error : undefined;
  const reasonCode = workspaceReasonCode(status, exitCode, readString(error?.code));
  const sections: ToolDetailSection[] = [];

  if (command) {
    sections.push({ label: "Command", value: command });
  }
  pushSection(
    sections,
    "Result",
    joinParts([
      status ? `status ${status}` : undefined,
      exitCode !== undefined ? `exit ${exitCode}` : undefined,
      durationMs !== undefined ? formatDuration(durationMs) : undefined,
      reasonCode ? `reason ${reasonCode}` : undefined
    ])
  );
  if (output) {
    sections.push({
      label: "Output bytes",
      value: joinParts([
        `stdout preview ${formatBytes(stdoutBytes)}${truncated?.stdout === true ? " (truncated)" : ""}`,
        `stderr preview ${formatBytes(stderrBytes)}${truncated?.stderr === true ? " (truncated)" : ""}`
      ])
    });
  }
  if (status === "failed") {
    sections.push(...workspaceExecFailurePreviewSections(output, error, truncated));
  }

  const changedSummary = summarizeWorkspaceFiles(changedFiles);
  const promotedSummary = summarizePromotedArtifacts(promotedArtifacts);
  if (changedSummary || promotedSummary) {
    sections.push({
      label: "Files",
      value: joinParts([changedSummary, promotedSummary])
    });
  }

  const actionLabel = command ?? "Workspace command";
  return {
    actionLabel,
    summary: joinParts([
      command ? `Ran ${command}` : "Ran a workspace command",
      status ? `status ${status}` : undefined,
      exitCode !== undefined ? `exit ${exitCode}` : undefined,
      durationMs !== undefined ? formatDuration(durationMs) : undefined,
      reasonCode ? `reason ${reasonCode}` : undefined
    ]),
    sections
  };
}

function workspaceExecFailurePreviewSections(
  output: Record<string, unknown> | undefined,
  error: Record<string, unknown> | undefined,
  truncated: Record<string, unknown> | undefined
): ToolDetailSection[] {
  return compactSections([
    failurePreviewSection("Stdout preview", readString(output?.stdoutPreview), truncated?.stdout === true),
    failurePreviewSection("Stderr preview", readString(output?.stderrPreview), truncated?.stderr === true),
    error ? { label: "Error", value: sanitizeWorkspaceFailurePreview(error) } : undefined
  ]);
}

function failurePreviewSection(
  label: string,
  value: string | undefined,
  runnerTruncated: boolean
): ToolDetailSection | undefined {
  if (!value) {
    return undefined;
  }
  const preview = sanitizeWorkspaceFailurePreview(value);
  if (!preview) {
    return undefined;
  }
  return {
    label,
    value: runnerTruncated ? `${preview}\n[truncated by runner]` : preview
  };
}

function sanitizeWorkspaceFailurePreview(value: unknown): string {
  const sanitized = typeof value === "string"
    ? sanitizeFailurePreviewStringOrJson(value)
    : stringifySanitizedFailureJson(value);
  return boundText(sanitized, MAX_FAILURE_PREVIEW_CHARS);
}

function sanitizeFailurePreviewStringOrJson(value: string): string {
  const parsed = tryParseJson(value);
  if (parsed.parsed) {
    return stringifySanitizedFailureJson(parsed.value);
  }
  return sanitizeFailureString(value, { broadContent: false });
}

function stringifySanitizedFailureJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeFailureJsonValue(value, 0, undefined), null, 2);
  } catch {
    return sanitizeFailureString(String(value), { broadContent: false });
  }
}

function sanitizeFailureJsonValue(value: unknown, depth: number, key: string | undefined): unknown {
  if (depth > MAX_FAILURE_JSON_DEPTH) {
    return "[omitted nested data]";
  }
  if (isBroadContentKey(key)) {
    return "[omitted broad content]";
  }
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value === "string") {
    return sanitizeFailureString(value, { broadContent: isBroadContentKey(key) });
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_FAILURE_JSON_ARRAY_ITEMS)
      .map((item) => sanitizeFailureJsonValue(item, depth + 1, key));
    if (value.length > MAX_FAILURE_JSON_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_FAILURE_JSON_ARRAY_ITEMS} more items omitted]`);
    }
    return items;
  }
  if (!isRecord(value)) {
    return sanitizeFailureString(String(value), { broadContent: false });
  }
  const output: Record<string, unknown> = {};
  let included = 0;
  let omitted = 0;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (isOmittedFailureKey(entryKey)) {
      omitted += 1;
      continue;
    }
    if (isSensitiveFailureKey(entryKey)) {
      output[entryKey] = "[redacted]";
      included += 1;
      continue;
    }
    if (included >= MAX_FAILURE_JSON_OBJECT_FIELDS) {
      omitted += 1;
      continue;
    }
    output[entryKey] = sanitizeFailureJsonValue(entryValue, depth + 1, entryKey);
    included += 1;
  }
  if (omitted > 0) {
    output.omittedFields = omitted;
  }
  return output;
}

function tryParseJson(value: string): { parsed: true; value: unknown } | { parsed: false } {
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/u.test(trimmed)) {
    return { parsed: false };
  }
  try {
    return { parsed: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { parsed: false };
  }
}

function sanitizeFailureString(
  value: string,
  options: {
    broadContent: boolean;
  }
): string {
  if (options.broadContent) {
    return "[omitted broad content]";
  }
  if (looksLikeStructuredMarkup(value)) {
    return "[omitted structured markup]";
  }
  return boundText(
    value
      .replaceAll(/https?:\/\/[^/@\s"']+:[^/@\s"']+@/giu, "https://[redacted]@")
      .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
      .replaceAll(
        /\b(api[_-]?key|token|secret|password|passwd|credential|authorization)\b\s*[:=]\s*["']?[^"',\s;}]+/giu,
        "$1=[redacted]"
      )
      .replaceAll(/\/Users\/[^\s"',;})]+/gu, "[redacted path]")
      .replaceAll(/\/tmp\/[^\s"',;})]+/gu, "[redacted path]")
      .replaceAll(/\/var\/folders\/[^\s"',;})]+/gu, "[redacted path]")
      .replaceAll(/(?:^|[\s"',:])(?:scratch|\.artifact-previews|artifact-previews|execution-workspaces)\/[^\s"',;})]+/giu, (match) =>
        match.slice(0, 1).match(/[\s"',:]/u) ? `${match.slice(0, 1)}[redacted path]` : "[redacted path]"
      )
      .replaceAll(/\b(?:art|ews|wcmd|file)_[a-z0-9_-]{6,}\b/giu, "[redacted id]"),
    MAX_FAILURE_STRING_CHARS
  );
}

function looksLikeStructuredMarkup(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^<\?(?:xml)\b/iu.test(trimmed) ||
    /^<!doctype\s+html\b/iu.test(trimmed) ||
    /<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*<\/\1>/u.test(trimmed)
  );
}

function isOmittedFailureKey(key: string): boolean {
  return /^(?:objectKey|workspacePath|commandId|workspaceId|artifactId|fileId)$/iu.test(key);
}

function isSensitiveFailureKey(key: string): boolean {
  return /(?:secret|token|password|passwd|credential|authorization|bearer|api[_-]?key)/iu.test(key);
}

function isBroadContentKey(key: string | undefined): boolean {
  return Boolean(key && /^(?:content|body|raw|rawXml|xml|html|base64|bytes|data|document)$/iu.test(key));
}

function projectWorkspaceImport(result: unknown): WorkspaceToolDisplayProjection {
  const output = readOutput(result);
  const importedFiles = readRecords(output?.importedFiles);
  const totalBytes = sumNumbers(importedFiles, "byteSize");
  const names = importedFiles.flatMap((file) => readDisplayFilenameList(file.filename ?? file.path));
  const count = importedFiles.length;
  const actionLabel = count > 0 ? `Imported ${formatCount(count, "file")}` : "Imported files";
  return {
    actionLabel,
    summary: joinParts([
      actionLabel,
      totalBytes > 0 ? formatBytes(totalBytes) : undefined,
      formatNameList(names)
    ]),
    sections: compactSections([
      {
        label: "Files",
        value: joinParts([
          count > 0 ? formatCount(count, "file") : undefined,
          totalBytes > 0 ? formatBytes(totalBytes) : undefined,
          formatNameList(names)
        ])
      }
    ])
  };
}

function projectWorkspaceReadFile(args: unknown, result: unknown): WorkspaceToolDisplayProjection {
  const input = isRecord(args) ? args : undefined;
  const output = readOutput(result);
  const filename = readDisplayFilename(output?.path ?? input?.path);
  const byteSize = readNumber(output?.byteSize);
  const previewBytes = byteLength(readString(output?.contentPreview) ?? "");
  const truncated = output?.truncated === true;
  const mimeType = readString(output?.mimeType);
  const actionLabel = filename ? `Read ${filename}` : "Read file";
  return {
    actionLabel,
    summary: joinParts([
      actionLabel,
      byteSize !== undefined ? `file ${formatBytes(byteSize)}` : undefined,
      output ? `preview ${formatBytes(previewBytes)}${truncated ? " (truncated)" : ""}` : undefined
    ]),
    sections: compactSections([
      {
        label: "File",
        value: joinParts([
          filename,
          mimeType,
          byteSize !== undefined ? `file ${formatBytes(byteSize)}` : undefined,
          output ? `preview ${formatBytes(previewBytes)}${truncated ? " (truncated)" : ""}` : undefined
        ])
      }
    ])
  };
}

function projectWorkspacePromoteArtifact(args: unknown, result: unknown): WorkspaceToolDisplayProjection {
  const input = isRecord(args) ? args : undefined;
  const output = readOutput(result);
  const artifacts = readToolArtifacts(result);
  const filename =
    readDisplayFilename(output?.filename) ??
    readDisplayFilename(artifacts[0]?.filename) ??
    readDisplayFilename(input?.filename) ??
    readDisplayFilename(output?.path ?? input?.path);
  const kind = readString(output?.kind) ?? readString(input?.kind) ?? artifacts[0]?.kind;
  const byteSize = readNumber(output?.byteSize);
  const mimeType = readString(output?.mimeType) ?? artifacts[0]?.mimeType;
  const actionLabel = filename ? `Promoted ${filename}` : "Promoted artifact";
  return {
    actionLabel,
    summary: joinParts([
      actionLabel,
      kind,
      mimeType,
      byteSize !== undefined ? formatBytes(byteSize) : undefined
    ]),
    sections: compactSections([
      {
        label: "Artifact",
        value: joinParts([
          filename,
          kind,
          mimeType,
          byteSize !== undefined ? formatBytes(byteSize) : undefined
        ])
      }
    ])
  };
}

function projectWorkspaceListFiles(result: unknown): WorkspaceToolDisplayProjection {
  const output = readOutput(result);
  const files = readRecords(output?.files);
  const totalBytes = sumNumbers(files, "byteSize");
  const promotedCount = files.reduce(
    (count, file) => count + readRecords(file.promotedArtifacts).length,
    0
  );
  return {
    actionLabel: files.length > 0 ? `Listed ${formatCount(files.length, "file")}` : "Listed files",
    summary: joinParts([
      files.length > 0 ? formatCount(files.length, "file") : "No files listed",
      totalBytes > 0 ? formatBytes(totalBytes) : undefined,
      promotedCount > 0 ? `${formatCount(promotedCount, "promoted artifact")}` : undefined
    ]),
    sections: compactSections([
      {
        label: "Files",
        value: joinParts([
          files.length > 0 ? formatCount(files.length, "file") : "No files listed",
          totalBytes > 0 ? formatBytes(totalBytes) : undefined,
          promotedCount > 0 ? `${formatCount(promotedCount, "promoted artifact")}` : undefined
        ])
      }
    ])
  };
}

function projectGenericWorkspaceTool(toolName: string, result: unknown): WorkspaceToolDisplayProjection {
  const container = isRecord(result) ? result : undefined;
  const output = isRecord(container?.output) ? container.output : undefined;
  const status = readString(output?.status) ?? readString(container?.status);
  const error = isRecord(container?.error) ? container.error : undefined;
  const reasonCode = readString(error?.code);
  const actionLabel = toolName.replace(/^workspace\./u, "").replaceAll("_", " ");
  return {
    actionLabel,
    summary: joinParts([
      actionLabel,
      status ? `status ${status}` : undefined,
      reasonCode ? `reason ${reasonCode}` : undefined
    ]),
    sections: compactSections([
      {
        label: "Result",
        value: joinParts([
          status ? `status ${status}` : undefined,
          reasonCode ? `reason ${reasonCode}` : undefined
        ])
      }
    ])
  };
}

function pushSection(sections: ToolDetailSection[], label: string, value: string): void {
  if (value.trim().length > 0) {
    sections.push({ label, value });
  }
}

function compactSections(sections: Array<ToolDetailSection | undefined>): ToolDetailSection[] {
  return sections.filter(
    (section): section is ToolDetailSection => Boolean(section && section.value.trim().length > 0)
  );
}

function readOutput(result: unknown): Record<string, unknown> | undefined {
  const container = isRecord(result) ? result : undefined;
  return isRecord(container?.output) ? container.output : undefined;
}

function readToolArtifacts(result: unknown): Array<{
  filename?: string;
  kind?: string;
  mimeType?: string;
}> {
  const container = isRecord(result) ? result : undefined;
  return readRecords(container?.artifacts).map((artifact) => ({
    ...(typeof artifact.filename === "string" ? { filename: artifact.filename } : {}),
    ...(typeof artifact.kind === "string" ? { kind: artifact.kind } : {}),
    ...(typeof artifact.mimeType === "string" ? { mimeType: artifact.mimeType } : {})
  }));
}

function summarizeWorkspaceFiles(files: Record<string, unknown>[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const totalBytes = sumNumbers(files, "byteSize");
  const names = files.flatMap((file) => readDisplayFilenameList(file.path));
  return joinParts([
    `${formatCount(files.length, "changed file")}`,
    totalBytes > 0 ? formatBytes(totalBytes) : undefined,
    formatNameList(names)
  ]);
}

function summarizePromotedArtifacts(artifacts: Record<string, unknown>[]): string | undefined {
  if (artifacts.length === 0) {
    return undefined;
  }
  const names = artifacts.flatMap((artifact) => readDisplayFilenameList(artifact.path));
  return joinParts([
    `${formatCount(artifacts.length, "promoted artifact")}`,
    formatNameList(names)
  ]);
}

function workspaceReasonCode(
  status: string | undefined,
  exitCode: number | undefined,
  errorCode: string | undefined
): string | undefined {
  if (errorCode) {
    return errorCode;
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "failed") {
    return exitCode === 124 ? "timeout" : "nonzero_exit";
  }
  return undefined;
}

function readCommandPrefix(tokens: string[]): { parts: string[]; nextIndex: number } | undefined {
  const first = tokens[0];
  if (!first || isShellBoundaryToken(first)) {
    return undefined;
  }
  const command = safeCommandName(first);
  if (!command) {
    return undefined;
  }

  if ((command === "python" || command === "python3") && tokens[1] === "-m") {
    const moduleName = tokens[2];
    if (moduleName && isSafeModuleName(moduleName)) {
      return { parts: [command, "-m", moduleName], nextIndex: 3 };
    }
  }

  return { parts: [command], nextIndex: 1 };
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (token) {
    tokens.push(token);
  }
  return tokens;
}

function safeCommandName(token: string): string | undefined {
  const basename = readDisplayFilename(token);
  if (!basename || !/^[a-zA-Z0-9_.-]{1,80}$/u.test(basename)) {
    return undefined;
  }
  return basename;
}

function isSafeFlagToken(token: string): boolean {
  return /^-{1,2}[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:=.*)?$/u.test(token) && token.length <= 120;
}

function isSafeCommandValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    !/[\\/\s]/u.test(value) &&
    !/^(?:file|art|ews|wcmd)_[a-z0-9_-]+$/iu.test(value) &&
    !/(?:objectkey|execution-workspaces|workspace-root|scratch|private|\/users\/|\/tmp\/)/iu.test(value)
  );
}

function flagAllowsDisplayedValue(flag: string): boolean {
  return !/(?:token|secret|password|passwd|credential|auth|bearer|key|path|file|dir|root|cwd|output|input|url|uri)/iu.test(
    flag
  );
}

function isSafeModuleName(value: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,100}$/u.test(value);
}

function isShellBoundaryToken(token: string): boolean {
  return token === "&&" || token === "||" || token === "|" || token === ";" || token === "&";
}

function readDisplayFilename(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const basename = normalized.split("/").at(-1)?.trim();
  if (!basename || basename === "." || basename === "..") {
    return undefined;
  }
  return basename.length > 120 ? `${basename.slice(0, 117)}...` : basename;
}

function readDisplayFilenameList(value: unknown): string[] {
  const filename = readDisplayFilename(value);
  return filename ? [filename] : [];
}

function formatNameList(names: string[]): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  const listed = names.slice(0, MAX_LISTED_NAMES).join(", ");
  const remaining = names.length - MAX_LISTED_NAMES;
  return remaining > 0 ? `${listed}, +${remaining} more` : listed;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function sumNumbers(records: Record<string, unknown>[], key: string): number {
  return records.reduce((sum, record) => {
    const value = readNumber(record[key]);
    return value === undefined ? sum : sum + value;
  }, 0);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated for display]` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatDecimal(bytes / 1024)} KB`;
  }
  return `${formatDecimal(bytes / (1024 * 1024))} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${formatDecimal(ms / 1000)} s`;
}

function formatDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("; ");
}

function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
