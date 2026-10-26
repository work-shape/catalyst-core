import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { type ReactNode } from "react";
import { readToolDisplayPayloadFromToolResult } from "../../shared/domain-ui-widgets";
import { connectionOperationOfTool } from "../../shared/connection-facts";
import { useTranslation } from "../../shared/i18n";
import { connectCardOfRefusal } from "../../studio/build-area/connection-connect-card-model";
import {
  isFailedWorkspaceExecResult,
  projectWorkspaceToolDisplay,
  type ToolDetailSection
} from "./workspace-tool-display";

export function toolStatusLabel(
  state: "running" | "completed" | "failed",
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (state === "running") {
    return t("toolRunning");
  }
  if (state === "failed") {
    return t("toolFailed");
  }
  return t("toolCompleted");
}

export function toolUiState({
  isError,
  result,
  status,
  toolName
}: {
  isError?: boolean;
  result: unknown;
  status?: ToolCallMessagePartProps["status"];
  toolName: string;
}): "running" | "completed" | "failed" {
  if (isError || status?.type === "incomplete") {
    return "failed";
  }
  if (status?.type === "running" || status?.type === "requires-action" || result === undefined) {
    return "running";
  }
  // A call refused for a missing sign-in carries its refusal as its output (CHAT-CONN-2b).
  if (isFailedWorkspaceExecResult({ result, toolName }) || connectCardOfRefusal(result)) {
    return "failed";
  }
  return "completed";
}

export function toolDetailSections({
  args,
  argsText,
  labels,
  toolName,
  result
}: {
  args: unknown;
  argsText?: string;
  labels: { input: string; output: string };
  toolName: string;
  result: unknown;
}): ToolDetailSection[] {
  if (isWorkspaceToolName(toolName)) {
    return projectWorkspaceToolDisplay({ args, result, toolName })?.sections ?? [];
  }
  const input = formatDetails(argsText && argsText.trim().length > 0 ? argsText : args);
  const sentence = readErrorSentence(result);
  const output = sentence ?? formatDetails(result);
  const sections: ToolDetailSection[] = [];
  if (input) {
    sections.push({ label: labels.input, value: input });
  }
  if (output) {
    sections.push({
      label: labels.output,
      value: output,
      ...(sentence === undefined ? {} : { kind: "text" as const })
    });
  }
  return sections;
}

export function readToolDetailSections(input: {
  args: unknown;
  argsText?: string;
  labels: { input: string; output: string };
  result: unknown;
  toolName: string;
}): ToolDetailSection[] {
  return toolDetailSections(input);
}

export function readToolActionLabel(input: {
  args: unknown;
  result: unknown;
  toolName: string;
}): string | undefined {
  return projectWorkspaceToolDisplay(input)?.actionLabel ?? readToolSubjectLabel(input);
}

export function readToolDisplayProjection(input: {
  args: unknown;
  result: unknown;
  toolName: string;
  locale: LocaleCode;
}): {
  actionLabel?: string;
  technicalName: string;
  title: string;
} {
  return {
    actionLabel: readToolActionLabel(input),
    technicalName: input.toolName,
    title:
      readTranslatedToolTitle(input.toolName, input.locale) ??
      readOperationToolTitle(input.toolName, input.locale) ??
      humanizeToolName(input.toolName)
  };
}

const TOOL_TITLES_BY_LOCALE: Record<LocaleCode, Record<string, string>> = {
  en: {
    "platform.context": "Check what this platform offers",
    "platform.assets.list": "Search the platform",
    "platform.assets.open": "Open the asset",
    "platform.assets.get": "Read the asset",
    "platform.assets.validate": "Check the draft",
    "platform.assets.put": "Save the draft",
    "platform.assets.operations": "Look up what a step may call",
    "platform.connections.propose": "Propose a connection",
    "platform.connections.draft_tools": "Draft access to an API",
    "platform.connections.offer_to_agent": "Offer tools to an agent",
    "assets.publish": "Publish",
    "mail.send": "Send an e-mail",
    read_skill: "Read instructions",
    show_view: "Show an overview",
    "structured_data.publish": "Update the fact sheet",
    "structured_data.read": "Read the fact sheet",
    "structured_result.read": "Reopen an earlier result",
    "tool_result.read": "Read the rest of a result",
    "workspace.exec": "Run command",
    "workspace.list_files": "List files",
    "workspace.import_files": "Import files",
    "workspace.read_file": "Read file",
    "workspace.write_file": "Write file",
    "workspace.edit_file": "Edit file",
    "workspace.promote_artifact": "Prepare download",
    "workspace.preview_images": "Preview images"
  },
  de: {
    "platform.context": "Angebot der Plattform prüfen",
    "platform.assets.list": "Plattform durchsuchen",
    "platform.assets.open": "Asset öffnen",
    "platform.assets.get": "Asset lesen",
    "platform.assets.validate": "Entwurf prüfen",
    "platform.assets.put": "Entwurf speichern",
    "platform.assets.operations": "Nachschlagen, was ein Schritt aufrufen darf",
    "platform.connections.propose": "Verbindung vorschlagen",
    "platform.connections.draft_tools": "Zugriff auf eine API entwerfen",
    "platform.connections.offer_to_agent": "Tools einem Agenten anbieten",
    "assets.publish": "Veröffentlichen",
    "mail.send": "E-Mail senden",
    read_skill: "Anleitung lesen",
    show_view: "Übersicht zeigen",
    "structured_data.publish": "Faktenblatt aktualisieren",
    "structured_data.read": "Faktenblatt lesen",
    "structured_result.read": "Früheres Ergebnis öffnen",
    "tool_result.read": "Rest eines Ergebnisses lesen",
    "workspace.exec": "Befehl starten",
    "workspace.list_files": "Dateien auflisten",
    "workspace.import_files": "Dateien importieren",
    "workspace.read_file": "Datei lesen",
    "workspace.write_file": "Datei schreiben",
    "workspace.edit_file": "Datei bearbeiten",
    "workspace.promote_artifact": "Download vorbereiten",
    "workspace.preview_images": "Vorschau laden"
  }
};

const TOOL_NAME_ACRONYMS = new Set([
  "api",
  "csv",
  "docx",
  "html",
  "id",
  "json",
  "ocr",
  "pdf",
  "pptx",
  "sql",
  "ui",
  "url",
  "xlsx"
]);

function readTranslatedToolTitle(toolName: string, locale: LocaleCode): string | undefined {
  return TOOL_TITLES_BY_LOCALE[locale][toolName] ?? TOOL_TITLES_BY_LOCALE.en[toolName];
}

/**
 * The tools of a Data Store and of a Knowledge Base by what they do, whichever store or base
 * they name: `data_store.<id>.insert` is "Add rows", `knowledge.<id>.add_files` "Add files to
 * the Knowledge Base".
 */
const OPERATION_TOOL_TITLES_BY_LOCALE: Record<LocaleCode, Record<string, string>> = {
  en: {
    "data_store.describe": "Read the data store's columns",
    "data_store.query": "Read rows",
    "data_store.preview_rows": "Preview rows",
    "data_store.insert": "Add rows",
    "data_store.update": "Change rows",
    "data_store.delete_rows": "Delete rows",
    "knowledge.add_files": "Add files to the Knowledge Base"
  },
  de: {
    "data_store.describe": "Spalten des Data Stores lesen",
    "data_store.query": "Datensätze lesen",
    "data_store.preview_rows": "Datensätze ansehen",
    "data_store.insert": "Datensätze hinzufügen",
    "data_store.update": "Datensätze ändern",
    "data_store.delete_rows": "Datensätze löschen",
    "knowledge.add_files": "Dateien zur Wissensbasis hinzufügen"
  }
};

function readOperationToolTitle(toolName: string, locale: LocaleCode): string | undefined {
  const segments = toolName.split(".");
  const key = `${segments[0] ?? ""}.${segments.at(-1) ?? ""}`;
  return OPERATION_TOOL_TITLES_BY_LOCALE[locale][key];
}

function readToolSubjectLabel(input: {
  args: unknown;
  result: unknown;
  toolName: string;
}): string | undefined {
  if (input.toolName === "read_skill") {
    return readSkillSubjectLabel(input.args, input.result);
  }
  if (input.toolName === "show_view") {
    const displayTitle = readDisplayProvidedTitle(
      readToolDisplayPayloadFromToolResult(input.result)
    );
    return displayTitle ?? readRecordString(input.args, "title");
  }
  return undefined;
}

function readSkillSubjectLabel(args: unknown, result: unknown): string | undefined {
  const output = isRecord(result) && isRecord(result.output) ? result.output : undefined;
  const skillName = readRecordString(args, "name");
  return readRecordString(output, "title") ?? (skillName ? humanizeToolName(skillName) : undefined);
}

function readDisplayProvidedTitle(
  display: { title?: unknown; data?: unknown } | undefined
): string | undefined {
  const title = readTrimmedString(display?.title);
  if (title) {
    return title;
  }
  return isRecord(display?.data) ? readRecordString(display.data, "title") : undefined;
}

function readRecordString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? readTrimmedString(value[key]) : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Words that only say a call reads; "Read list customers" reads as "Read customers". */
const READING_VERBS = new Set(["fetch", "find", "get", "list", "load", "query", "read", "search"]);

/** What is left of "get_me" or "read_all": no object a sentence can name. */
const PRONOUN_WORDS = new Set(["all", "any", "it", "me", "mine", "my", "myself", "self", "them"]);

/**
 * The operation of a Connection's tool call as it stands inside a sentence: "top customers"
 * for `connection.sample-business.top_customers`. Never the raw key: the name is turned into
 * words, and a version segment such as `v1` is left out. A reading operation drops the verbs
 * that only say it reads ("v1.orders.list" reads "orders"). Where nothing is left to name, or
 * only a word such as "me", a read has no operation and its sentence names the Connection alone.
 */
export function readConnectionOperationLabel(
  toolName: string,
  effect: "reading" | "changing" | undefined
): string | undefined {
  const operation = connectionOperationOfTool(toolName);
  if (operation === undefined) {
    return undefined;
  }
  const words = operationWords(operation);
  if (effect !== "reading") {
    return words.length > 0 ? words.join(" ") : operation.replace(/[._-]+/gu, " ");
  }
  if (words[0] !== undefined && READING_VERBS.has(words[0])) {
    words.shift();
  }
  const last = words.at(-1);
  if (words.length > 1 && last !== undefined && READING_VERBS.has(last)) {
    words.pop();
  }
  return words.length === 0 || words.every((word) => PRONOUN_WORDS.has(word))
    ? undefined
    : words.join(" ");
}

/** "ZRFC_GET_OPEN_ITEMS", "getCustomerByID" and "v1.orders.list" as words in lower case. */
function operationWords(operation: string): string[] {
  return operation
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[\s._-]+/u)
    .filter((word) => word.length > 0 && !/^v\d+$/iu.test(word))
    .map((word) =>
      TOOL_NAME_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()
    );
}

/**
 * How many rows the result of a call holds, where it has rows: an array `rows` of records in the
 * result, in its `output` or in its `structuredContent` (a Connection's answer). Nothing
 * otherwise, also for an array that holds anything but records.
 */
export function readResultRowCount(result: unknown): number | undefined {
  const output = isRecord(result) ? result.output : undefined;
  const candidates = [
    result,
    output,
    isRecord(result) ? result.structuredContent : undefined,
    isRecord(output) ? output.structuredContent : undefined
  ];
  for (const candidate of candidates) {
    // Rows are records; an array of anything else is not counted as rows.
    if (isRecord(candidate) && Array.isArray(candidate.rows) && candidate.rows.every(isRecord)) {
      return candidate.rows.length;
    }
  }
  return undefined;
}

/** What a finished `show_view` showed, read from its view: a table, a chart or an overview. */
export function readShownViewKind(result: unknown): "table" | "chart" | "view" {
  const display = readToolDisplayPayloadFromToolResult(result);
  const html = isRecord(display?.data) ? display.data.html : undefined;
  if (typeof html !== "string") {
    return "view";
  }
  if (/<table[\s>]/iu.test(html)) {
    return "table";
  }
  return /<(svg|canvas)[\s>]/iu.test(html) ? "chart" : "view";
}

/**
 * The sentence of an output that is an error and nothing else, for the opened row of a failed
 * call. The technical details keep the output as it came.
 */
export function readToolErrorSentence(result: unknown): string | undefined {
  return readErrorSentence(result);
}

function humanizeToolName(toolName: string): string {
  const source = toolName.trim();
  if (!source) {
    return "Tool";
  }
  const lastSegment = source.split(".").filter(Boolean).at(-1) ?? source;
  const normalized = lastSegment
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim();
  if (!normalized) {
    return source;
  }
  return normalized
    .split(/\s+/u)
    .map((word) =>
      TOOL_NAME_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`
    )
    .join(" ");
}

function isWorkspaceToolName(toolName: string): boolean {
  return toolName.startsWith("workspace.");
}

/**
 * The sentence of an output that is an error and nothing else: `{ "error": "…" }`. Such an
 * output is read by a person, so it is shown as text and not as the JSON it arrived in.
 */
function readErrorSentence(result: unknown): string | undefined {
  if (!isRecord(result) || Object.keys(result).length !== 1) {
    return undefined;
  }
  return readTrimmedString(result.error);
}

export function formatDetails(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolSummary(
  result: unknown,
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const workspaceSummary = getWorkspaceCommandSummary(result, t);
  if (workspaceSummary) {
    return workspaceSummary;
  }
  const notice = isRecord(result.projectionNotice) ? result.projectionNotice : undefined;
  if (notice?.type === "tool_output_bounded") {
    return "This tool output was partially loaded into the agent context. The full output is stored with the conversation.";
  }
  if (typeof result.output === "string") {
    return result.output;
  }
  return undefined;
}

function getWorkspaceCommandSummary(
  result: Record<string, unknown>,
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  const output = isRecord(result.output) ? result.output : undefined;
  if (
    typeof output?.commandId !== "string" ||
    typeof output.workspaceId !== "string" ||
    !Array.isArray(output.changedFiles)
  ) {
    return undefined;
  }
  if (output.status === "failed") {
    return output.exitCode === 124 ? t("workspaceCommandTimedOut") : t("workspaceCommandFailed");
  }
  if (output.status === "cancelled") {
    return t("workspaceCommandCancelled");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasRenderedNode(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false;
}
