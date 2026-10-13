import { SUBJECT_TOOL_PREFIX, WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import type { Surface } from "../surface/surface";

// What the calls of a run tell of the asset its conversation is about. The read of an asset
// makes it the subject on the server; the browser reads the same from the answers of the run,
// so the surface of the asset opens while the run goes and redraws after each saved draft.

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

/** The asset an answer of `platform.assets.get` read. */
function assetRead(answer: Record<string, unknown> | undefined): SubjectAsset | undefined {
  return answer !== undefined && typeof answer.kind === "string" && typeof answer.name === "string"
    ? { kind: answer.kind, name: answer.name }
    : undefined;
}

/** The asset the last read of the run that stood names: what the conversation is about now. */
export function subjectReadInRun(parts: readonly SubjectRunPart[]): SubjectAsset | undefined {
  let subject: SubjectAsset | undefined;
  for (const part of parts) {
    subject = assetRead(answered(part, ASSET_GET_TOOL_NAME)) ?? subject;
  }
  return subject;
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
 * The surface of the asset a conversation is about: the canvas of a Workflow. Nothing for a
 * kind without one: a Page opens through its own card, and the other kinds show nothing beside
 * the chat yet.
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
  return undefined;
}
