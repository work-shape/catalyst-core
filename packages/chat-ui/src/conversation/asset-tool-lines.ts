import { APP_ASSET_KIND } from "@vivd-catalyst/api-client";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { AGENT_ASSET_KIND } from "../build-area/build-rights";
import type { TranslationContextValue, TranslationKey } from "../i18n";
import {
  ASSET_GET_TOOL_NAME,
  ASSET_OPERATIONS_TOOL_NAME,
  ASSET_PUT_TOOL_NAME,
  ASSET_VALIDATE_TOOL_NAME,
  toolAnswer
} from "./subject-run";

// The calls of the tools that read and save an asset, said in plain words: what the agent did
// to the asset, not that a tool was called.

/** One call as the thread shows it. `result` is absent while the call runs. */
export interface AssetToolCall {
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

const KIND_NOUNS: Readonly<Record<string, TranslationKey>> = {
  [WORKFLOW_ASSET_KIND]: "assetToolKindWorkflow",
  [APP_ASSET_KIND]: "assetToolKindApp",
  [AGENT_ASSET_KIND]: "assetToolKindAgent"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindNoun(kind: unknown, t: TranslationContextValue["t"]): string {
  const key = typeof kind === "string" ? KIND_NOUNS[kind] : undefined;
  return t(key ?? "assetToolKindOther");
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** The issues of a check or of a refused save, as one sentence. */
function issues(
  amount: number,
  t: TranslationContextValue["t"],
  keys: { none: TranslationKey; one: TranslationKey; many: TranslationKey }
): string {
  if (amount === 0) {
    return t(keys.none);
  }
  return amount === 1 ? t(keys.one) : t(keys.many, { count: amount });
}

/**
 * What one call of an asset tool did, in plain words. Nothing for a call of another tool, and
 * nothing where the answer says nothing the sentence could rest on.
 */
export function assetToolSentence(
  call: AssetToolCall,
  t: TranslationContextValue["t"]
): string | undefined {
  const args = isRecord(call.args) ? call.args : {};
  const answer = call.isError ? undefined : toolAnswer(call.result);
  const running = !call.isError && call.result === undefined;
  switch (call.toolName) {
    case ASSET_GET_TOOL_NAME: {
      if (call.isError) {
        return t("assetToolReadFailed");
      }
      const kind = kindNoun(answer?.kind ?? args.kind, t);
      return running ? t("assetToolReading", { kind }) : t("assetToolRead", { kind });
    }
    case ASSET_VALIDATE_TOOL_NAME:
      if (call.isError || running) {
        return t(call.isError ? "assetToolCheckFailed" : "assetToolChecking");
      }
      return issues(count(answer?.issues), t, {
        none: "assetToolCheckedClean",
        one: "assetToolCheckedOne",
        many: "assetToolCheckedMany"
      });
    case ASSET_PUT_TOOL_NAME: {
      if (call.isError || running) {
        return t(call.isError ? "assetToolSaveFailed" : "assetToolSaving");
      }
      if (answer?.saved === true && typeof answer.revision === "number") {
        return t("assetToolSaved", { number: answer.revision });
      }
      if (answer?.conflict !== undefined) {
        return t("assetToolSaveConflict");
      }
      return issues(count(answer?.issues), t, {
        none: "assetToolSaveFailed",
        one: "assetToolSaveRefusedOne",
        many: "assetToolSaveRefusedMany"
      });
    }
    case ASSET_OPERATIONS_TOOL_NAME:
      return t(call.isError ? "assetToolOperationsFailed" : "assetToolOperations");
    default:
      return undefined;
  }
}
