import { APP_ASSET_KIND } from "@vivd-catalyst/api-client";
import { SUBJECT_TOOL_PREFIX, WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { AGENT_ASSET_KIND } from "../build-area/build-rights";
import type { Surface } from "../surface/surface";

// What the calls of a run tell of the asset its conversation is about. Opening an asset makes
// it the subject on the server; the browser reads the same from the answers of the run, so the
// surface of the asset opens while the run goes and redraws after each saved draft. A read
// opens nothing.

export const ASSET_OPEN_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}open`;
export const ASSET_GET_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}get`;
export const ASSET_VALIDATE_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}validate`;
export const ASSET_PUT_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}put`;
export const ASSET_OPERATIONS_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}operations`;

/** The asset a conversation is about. */
export interface SubjectAsset {
  kind: string;
  name: string;
}

/** One part of a run as its projection carries it. */
export interface SubjectRunPart {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The answer of a call that stood, unwrapped from the envelope a tool result may carry. */
export function toolAnswer(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  return isRecord(result.output) ? result.output : result;
}

function answered(part: SubjectRunPart, toolName: string): Record<string, unknown> | undefined {
  return part.type === "tool_call" &&
    part.toolName === toolName &&
    part.state === "output_available"
    ? toolAnswer(part.output)
    : undefined;
}

/** The asset an answer of `platform.assets.open` opened. */
function assetOpened(answer: Record<string, unknown> | undefined): SubjectAsset | undefined {
  return answer !== undefined && typeof answer.kind === "string" && typeof answer.name === "string"
    ? { kind: answer.kind, name: answer.name }
    : undefined;
}

/**
 * The asset the last open of the run that stood names, and the call that opened it: what the
 * conversation is about now. Each open is a call of its own, so an asset opened again after
 * its reader closed it shows again.
 */
export function subjectOpenedInRun(
  parts: readonly SubjectRunPart[]
): { subject: SubjectAsset; callId: string | undefined } | undefined {
  let opened: { subject: SubjectAsset; callId: string | undefined } | undefined;
  for (const part of parts) {
    const subject = assetOpened(answered(part, ASSET_OPEN_TOOL_NAME));
    if (subject) {
      opened = { subject, callId: part.toolCallId };
    }
  }
  return opened;
}

/** The calls of the run that saved a draft of the subject, by their ids. */
export function savedDraftCalls(parts: readonly SubjectRunPart[]): string[] {
  return parts.flatMap((part) =>
    answered(part, ASSET_PUT_TOOL_NAME)?.saved === true && part.toolCallId !== undefined
      ? [part.toolCallId]
      : []
  );
}

/** The key of the surface of a subject: one per asset, so an asset opens once by itself. */
function subjectSurfaceKey(subject: SubjectAsset): string {
  return `subject:${subject.kind}:${subject.name}`;
}

/**
 * The surface of the asset a conversation is about: the canvas of a Workflow, the draft of an
 * App, the saved state of an agent. Nothing for a kind without one: a Page opens through its
 * own card, and the other kinds show nothing beside the chat yet.
 */
export function subjectSurface(input: {
  subject: SubjectAsset;
  workspaceId: string | undefined;
  title: string;
}): Surface | undefined {
  const { subject, workspaceId, title } = input;
  const key = subjectSurfaceKey(subject);
  if (subject.kind === WORKFLOW_ASSET_KIND && workspaceId !== undefined) {
    return { kind: "workflow_canvas", key, title, workspaceId, workflow: subject.name };
  }
  if (subject.kind === APP_ASSET_KIND && workspaceId !== undefined) {
    return { kind: "app_edit", key, title, workspaceId, app: subject.name };
  }
  if (subject.kind === AGENT_ASSET_KIND) {
    return { kind: "agent", key, title, agent: subject.name };
  }
  return undefined;
}
