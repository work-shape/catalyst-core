import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { type ReactNode } from "react";
import { readToolDisplayPayloadFromToolResult } from "../../shared/domain-ui-widgets";
import { useTranslation } from "../../shared/i18n";
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
  if (isFailedWorkspaceExecResult({ result, toolName })) {
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
    title: readTranslatedToolTitle(input.toolName, input.locale) ?? humanizeToolName(input.toolName)
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
    "platform.assets.operations": "Look up operations",
    "platform.connections.draft_tools": "Draft REST API tools",
    read_skill: "Read instructions",
    show_view: "Widget",
    "structured_data.publish": "Update the fact sheet",
    "structured_data.read": "Read the fact sheet",
    "structured_result.read": "Reopen an earlier result",
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
    "platform.assets.operations": "Operationen nachschlagen",
    "platform.connections.draft_tools": "REST-API-Tools entwerfen",
    read_skill: "Anleitung lesen",
    show_view: "Widget",
    "structured_data.publish": "Faktenblatt aktualisieren",
    "structured_data.read": "Faktenblatt lesen",
    "structured_result.read": "Früheres Ergebnis öffnen",
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
