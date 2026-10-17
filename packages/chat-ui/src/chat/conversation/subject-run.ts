import { APP_ASSET_KIND } from "@work-shape/catalyst-api-client";
import {
  DATA_STORE_ASSET_KIND,
  SUBJECT_TOOL_PREFIX,
  WORKFLOW_ASSET_KIND
} from "@work-shape/catalyst-core";
import { AGENT_ASSET_KIND } from "../../shared/build-rights";
import { AGENTS_BUILD_PATH } from "../../shared/build-route";
import type { WorkspaceRoute } from "../../shared/routes";
import { FORMER_OPEN_TOOL_NAME } from "../../studio/pages/page-save";

// What the calls of a run tell of the asset its conversation is about. Opening an asset makes
// it the subject on the server; the browser reads the same from the answers of the run, so the
// person is taken to the asset's page while the run goes, and its page is read again after each
// saved draft. A read opens nothing.

export const ASSET_OPEN_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}open`;
export const ASSET_GET_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}get`;
export const ASSET_VALIDATE_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}validate`;
export const ASSET_PUT_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}put`;
export const ASSET_OPERATIONS_TOOL_NAME = `${SUBJECT_TOOL_PREFIX}operations`;
/**
 * Keeps what the conversation opened as an App, which the conversation is about from then on;
 * a later call writes the App's next draft revision.
 */
export const APP_SAVE_TOOL_NAME = "app.save";
/** The former name of `app.save`, whose calls stored conversations still hold. */
export const FORMER_APP_SAVE_TOOL_NAME = "page.save_as_app";

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

/**
 * One open of an asset that stood: an answer of `platform.assets.open`, of the `app.save` that
 * created an App, or of the first `platform.assets.put` of a conversation, which creates the
 * asset it opens.
 */
export interface AssetOpen {
  subject: SubjectAsset;
  /** The name people read for the asset, as the answer says it. */
  title: string;
  callId: string | undefined;
  /**
   * The asset belongs to the whole instance and the open did not make it the subject: that
   * waits for the person to go to it (`conversations.subject.open`).
   */
  awaitsPerson: boolean;
  /** The workspace that owns the asset, by its id. Absent for an asset of the instance. */
  owner?: string;
  /**
   * The agent created the asset while the conversation was about another one (BUILD-ALL-1):
   * it is no open. The conversation stays about its subject and nobody is moved; the line says
   * "created" and offers the way to the new draft.
   */
  besideSubject?: true;
}

/** The open an answer of `platform.assets.open` or of a save that created an asset says. */
function assetOpenOfAnswer(
  answer: Record<string, unknown> | undefined,
  callId: string | undefined
): AssetOpen | undefined {
  if (answer === undefined || typeof answer.kind !== "string" || typeof answer.name !== "string") {
    return undefined;
  }
  return {
    subject: { kind: answer.kind, name: answer.name },
    title: typeof answer.title === "string" && answer.title !== "" ? answer.title : answer.name,
    callId,
    awaitsPerson: answer.awaitsPerson === true,
    ...(typeof answer.workspaceId === "string" ? { owner: answer.workspaceId } : {}),
    ...(answer.besideSubject === true ? { besideSubject: true as const } : {})
  };
}

/** The answer of a save that created the asset: the first save of a conversation opens it. */
function createdBy(answer: Record<string, unknown> | undefined) {
  return answer?.created === true ? answer : undefined;
}

/** The answer of a save that created the asset and opened it: not one beside the subject. */
function openedBy(answer: Record<string, unknown> | undefined) {
  return answer?.besideSubject === true ? undefined : createdBy(answer);
}

/**
 * The open a call of `platform.assets.open` made, or the save that created an asset, once it
 * stood. The thread shows it as a line of its own that leads to the asset's page; a draft created
 * beside the subject says so (`besideSubject`).
 */
export function standingAssetOpen(call: {
  toolName: string;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
}): AssetOpen | undefined {
  if (call.isError === true) return undefined;
  const answer = toolAnswer(call.result);
  if (call.toolName === ASSET_OPEN_TOOL_NAME) return assetOpenOfAnswer(answer, call.toolCallId);
  return call.toolName === ASSET_PUT_TOOL_NAME
    ? assetOpenOfAnswer(createdBy(answer), call.toolCallId)
    : undefined;
}

/**
 * Every open of the run that stood, in order. The first save of an App or of any asset opens
 * the asset it created; a draft created beside the subject opens nothing.
 */
export function opensInRun(parts: readonly SubjectRunPart[]): AssetOpen[] {
  return parts.flatMap((part) => {
    const open = assetOpenOfAnswer(
      answered(part, ASSET_OPEN_TOOL_NAME) ??
        answered(part, FORMER_APP_SAVE_TOOL_NAME) ??
        createdBy(answered(part, APP_SAVE_TOOL_NAME)) ??
        openedBy(answered(part, ASSET_PUT_TOOL_NAME)),
      part.toolCallId
    );
    return open === undefined ? [] : [open];
  });
}

/**
 * The asset the last open of the run that made it the subject names, and the call that opened
 * it: what the conversation is about now. An open that waits for the person changed nothing.
 */
export function subjectOpenedInRun(
  parts: readonly SubjectRunPart[]
): { subject: SubjectAsset; callId: string | undefined } | undefined {
  const opened = opensInRun(parts).filter((open) => !open.awaitsPerson);
  const last = opened.at(-1);
  return last === undefined ? undefined : { subject: last.subject, callId: last.callId };
}

/** Whether two names say the same asset. */
export function sameAsset(a: SubjectAsset | undefined, b: SubjectAsset | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.name === b.name;
}

/** The path segments of skills and Data Stores in Build. */
const SKILLS_BUILD_PATH = "skills";
const DATA_STORES_BUILD_PATH = "data-stores";
const SKILL_ASSET_KIND = "skill";

/**
 * The page of an asset, where its kind has one: an agent, a skill or a Data Store in Build, a
 * Workflow on its canvas, an App on its draft page. A Workflow and an App have their pages in a
 * workspace.
 */
export function assetPageRoute(
  subject: SubjectAsset,
  workspaceId: string | undefined
): WorkspaceRoute | undefined {
  if (subject.kind === AGENT_ASSET_KIND) {
    return { kind: "build-asset", assetKind: AGENTS_BUILD_PATH, name: subject.name };
  }
  if (subject.kind === SKILL_ASSET_KIND) {
    return { kind: "build-asset", assetKind: SKILLS_BUILD_PATH, name: subject.name };
  }
  if (subject.kind === DATA_STORE_ASSET_KIND) {
    return { kind: "build-asset", assetKind: DATA_STORES_BUILD_PATH, name: subject.name };
  }
  if (workspaceId === undefined) {
    return undefined;
  }
  if (subject.kind === WORKFLOW_ASSET_KIND) {
    return { kind: "workflow", collaborationWorkspaceId: workspaceId, workflow: subject.name };
  }
  return subject.kind === APP_ASSET_KIND
    ? { kind: "app-edit", collaborationWorkspaceId: workspaceId, app: subject.name }
    : undefined;
}

/** Whether a call of the former `page.save` also wrote the draft of the conversation's App. */
function savedIntoApp(answer: Record<string, unknown> | undefined): boolean {
  const app = answer?.app;
  return isRecord(app) && app.saved === true;
}

/**
 * The calls of the run that saved a draft of the subject, by their ids: a save of the asset or
 * of the App, and a call of the former `page.save` that wrote the App's draft.
 */
export function savedDraftCalls(parts: readonly SubjectRunPart[]): string[] {
  return parts.flatMap((part) =>
    (answered(part, ASSET_PUT_TOOL_NAME)?.saved === true ||
      answered(part, APP_SAVE_TOOL_NAME)?.saved === true ||
      savedIntoApp(answered(part, FORMER_OPEN_TOOL_NAME))) &&
    part.toolCallId !== undefined
      ? [part.toolCallId]
      : []
  );
}
