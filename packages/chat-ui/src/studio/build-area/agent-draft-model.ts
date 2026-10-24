import type { AgentDraft } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";
import { ASSET_LANGUAGES, type AgentFormState, type LocalizedPair } from "./asset-form-model";
import { readRefusalDetails } from "./build-refusals";
import { apiErrorCode } from "../../shared/workspace-utils";

// The agent's one draft on its page (AD-4): the page edits the draft, and each field the draft
// changes shows the published value beside it. The page compares the draft with the live agent
// field by field, as the form holds them.

/** A field of the agent page that a draft can change. */
export type DraftAgentField =
  | "displayName"
  | "description"
  | "welcomeMessage"
  | "welcomeSubtitle"
  | "instructions"
  | "maxSteps"
  | "model"
  | "skillNames"
  | "knowledgeBases"
  | "toolNames"
  | "initialPrompts";

/** The parts of the form the Model section shows as one field. */
const MODEL_PARTS = [
  "modelProviderId",
  "modelBindingId",
  "reasoningEffort",
  "fastMode",
  "userSelectableModelBindingIds",
  "modelReasoningEfforts"
] as const satisfies readonly (keyof AgentFormState)[];

/** Each field in the order of the page, with the parts of the form it shows. */
const FIELD_PARTS: readonly (readonly [DraftAgentField, readonly (keyof AgentFormState)[]])[] = [
  ["displayName", ["displayName"]],
  ["description", ["description"]],
  ["welcomeMessage", ["welcomeMessage"]],
  ["welcomeSubtitle", ["welcomeSubtitle"]],
  ["instructions", ["instructions"]],
  ["maxSteps", ["maxSteps"]],
  ["model", MODEL_PARTS],
  ["skillNames", ["skillNames"]],
  ["knowledgeBases", ["knowledgeBases"]],
  ["toolNames", ["toolNames"]],
  ["initialPrompts", ["initialPrompts"]]
];

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The fields the draft changes against the live agent, in the order of the page. */
export function draftAgentFields(live: AgentFormState, draft: AgentFormState): DraftAgentField[] {
  return FIELD_PARTS.filter(([, parts]) =>
    parts.some((part) => !same(live[part], draft[part]))
  ).map(([field]) => field);
}

/** The section of the agent page each field stands in, by the section's anchor. */
const SECTION_OF_FIELD: Record<DraftAgentField, string> = {
  displayName: "overview",
  description: "overview",
  welcomeMessage: "overview",
  welcomeSubtitle: "overview",
  instructions: "instructions",
  maxSteps: "instructions",
  model: "model",
  skillNames: "skills",
  knowledgeBases: "knowledge",
  toolNames: "tools",
  initialPrompts: "prompts"
};

/** The sections that hold a field the draft changes. */
export function draftSections(fields: readonly DraftAgentField[]): Set<string> {
  return new Set(fields.map((field) => SECTION_OF_FIELD[field]));
}

/** The languages of a text the draft changes, each with its published text. */
export function changedLanguages(
  live: LocalizedPair,
  draft: LocalizedPair
): { language: keyof LocalizedPair; text: string }[] {
  return ASSET_LANGUAGES.filter((language) => live[language] !== draft[language]).map(
    (language) => ({ language, text: live[language] })
  );
}

/**
 * What a refused Publish or Discard means for the page: somebody wrote a newer draft than the
 * one the person read (`changed`), or the live agent changed since the draft was written
 * (`stale`). Anything else is told in the instance's words.
 */
export type AgentDraftRefusal = "changed" | "stale";

export function readDraftRefusal(error: unknown): AgentDraftRefusal | undefined {
  const code = apiErrorCode(error);
  const { reason } = readRefusalDetails(error);
  if (code === "REVISION_CONFLICT" && reason === "draft_changed") return "changed";
  if (code === "CONFLICT" && reason === "stale_base") return "stale";
  return undefined;
}

/**
 * Who wrote the draft last, as people read it: the person by name, with the agent where it
 * wrote the draft in their Build conversation, or the team that runs the instance for a release
 * push. A person who is gone, or whose name the instance did not tell, is named as unknown. It
 * opens a sentence: the author is its subject.
 */
export function draftAuthorLabel(
  author: AgentDraft["author"],
  t: TranslationContextValue["t"]
): string {
  if (author.release) return t("agentDraft.authorRelease");
  const name = author.name?.trim() || t("agentDraft.authorUnknown");
  return author.conversationId === undefined ? name : t("agentDraft.authorWithAgent", { name });
}
