import { GUARDRAIL_OUTCOMES } from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";

// When a guardrail runs and what it does, in one line a person reads: built from its event,
// its filter, its check, its outcome and its scope, in the reader's language. Pure, so a
// Workflow step or an App action can name the guardrails that watch it with the same words.

/** What a guardrail does on a hit. */
export type GuardrailOutcomeName = (typeof GUARDRAIL_OUTCOMES)[number];

/** What the sentence is built from: a guardrail's definition and where it applies. */
export interface GuardrailRunFacts {
  /** The before-event, such as `asset.before_write`. One this build does not know is not named. */
  event: string;
  outcome: GuardrailOutcomeName;
  /** The check on the content. Absent: the guardrail answers every event it applies to. */
  checkKind?: "pattern" | "model_judge";
  /** The filter: the kind of asset or request, the operation, where the call comes from, the agent and the workspace. */
  kind?: string;
  operation?: string;
  callOrigin?: string;
  agent?: string;
  workspace?: string;
  /** Who the guardrail belongs to: the instance or one workspace. */
  scope: { kind: "instance" } | { kind: "workspace"; workspaceId: string };
  /** Set in release config: the operator's floor. */
  setByOperator: boolean;
}

/** What the sentence asks of the page it is shown on. */
export interface GuardrailSentenceWords {
  t(key: TranslationKey, values?: Record<string, string | number>): string;
  /** A workspace's name, where the reader may know it. */
  workspaceName(id: string): string | undefined;
  /** A kind of approval request in words, as the Inbox names it. */
  requestKind(kind: string): string | undefined;
}

const ASSET_PHRASES: Record<string, TranslationKey> = {
  skill: "guardrails.runs.assetSkill",
  agent: "guardrails.runs.assetAgent",
  app: "guardrails.runs.assetApp",
  workflow: "guardrails.runs.assetWorkflow",
  data_store: "guardrails.runs.assetDataStore",
  knowledge_base: "guardrails.runs.assetKnowledgeBase",
  connection: "guardrails.runs.assetConnection",
  guardrail: "guardrails.runs.assetGuardrail"
};

const ORIGIN_PHRASES: Record<string, TranslationKey> = {
  agent: "guardrails.runs.byAgent",
  user: "guardrails.runs.byPerson",
  cli: "guardrails.runs.byCli",
  mcp: "guardrails.runs.byMcp",
  app: "guardrails.runs.byApp",
  workflow: "guardrails.runs.byWorkflow",
  schedule: "guardrails.runs.bySchedule"
};

const PUBLISH_EVENTS: Record<string, TranslationKey> = {
  "app.before_publish": "guardrails.runs.appPublish",
  "workflow.before_publish": "guardrails.runs.workflowPublish",
  "data_store.before_publish": "guardrails.runs.dataStorePublish"
};

const OUTCOMES_ON_CHECK: Record<GuardrailOutcomeName, TranslationKey> = {
  block: "guardrails.runs.blocksOnCheck",
  require_approval: "guardrails.runs.approvalOnCheck",
  warn: "guardrails.runs.warnsOnCheck",
  allow: "guardrails.runs.allows"
};

const OUTCOMES_ALWAYS: Record<GuardrailOutcomeName, TranslationKey> = {
  block: "guardrails.runs.blocksAlways",
  require_approval: "guardrails.runs.approvalAlways",
  warn: "guardrails.runs.warnsAlways",
  allow: "guardrails.runs.allows"
};

/**
 * One line that says exactly when a guardrail runs and what it does, such as "Runs before an
 * agent saves a skill, in workspace Kai Spezis. Checks the content for a text pattern. Blocks
 * if the check fails." It names no event id: an event this build does not know is said to be
 * an action it cannot name.
 */
export function guardrailRunSentence(
  facts: GuardrailRunFacts,
  words: GuardrailSentenceWords
): string {
  const { t } = words;
  const parts = [
    `${t("guardrails.runs.sentence", {
      when: whenClause(facts, words),
      where: whereClause(facts, words)
    })}`
  ];
  if (facts.checkKind !== undefined) {
    parts.push(
      t(
        facts.checkKind === "pattern"
          ? "guardrails.runs.checkPattern"
          : "guardrails.runs.checkJudge"
      )
    );
  }
  parts.push(
    t((facts.checkKind === undefined ? OUTCOMES_ALWAYS : OUTCOMES_ON_CHECK)[facts.outcome])
  );
  return parts.join(" ");
}

/** Before what the guardrail runs, and whose action it is. */
function whenClause(facts: GuardrailRunFacts, words: GuardrailSentenceWords): string {
  const { t } = words;
  const actor = actorPhrase(facts, words);
  switch (facts.event) {
    case "asset.before_write":
      return t("guardrails.runs.assetWrite", { actor, asset: assetPhrase(facts.kind, words) });
    case "operation.before_call":
      return t("guardrails.runs.operationCall", {
        actor,
        operation:
          facts.operation === undefined
            ? t("guardrails.runs.anyOperation")
            : facts.operation.endsWith(".*")
              ? t("guardrails.runs.operationPrefix", { prefix: facts.operation.slice(0, -1) })
              : t("guardrails.runs.operationNamed", { name: facts.operation })
      });
    case "approval_request.before_create": {
      const kind = facts.kind === undefined ? undefined : words.requestKind(facts.kind);
      return kind === undefined
        ? t("guardrails.runs.approvalRequest", { actor })
        : t("guardrails.runs.approvalRequestOfKind", { actor, kind });
    }
    default: {
      const publish = PUBLISH_EVENTS[facts.event];
      return publish ? t(publish, { actor }) : t("guardrails.runs.unknownEvent");
    }
  }
}

function actorPhrase(facts: GuardrailRunFacts, { t }: GuardrailSentenceWords): string {
  if (facts.agent !== undefined) return t("guardrails.runs.byNamedAgent", { name: facts.agent });
  const origin = facts.callOrigin === undefined ? undefined : ORIGIN_PHRASES[facts.callOrigin];
  return t(origin ?? "guardrails.runs.byAnyone");
}

function assetPhrase(kind: string | undefined, { t }: GuardrailSentenceWords): string {
  if (kind === undefined) return t("guardrails.runs.assetAny");
  const phrase = ASSET_PHRASES[kind];
  return phrase ? t(phrase) : t("guardrails.runs.assetOfKind", { kind });
}

/** Where the guardrail applies: the instance, or one workspace by its name where it is known. */
function whereClause(facts: GuardrailRunFacts, words: GuardrailSentenceWords): string {
  const { t } = words;
  const workspaceId = facts.scope.kind === "workspace" ? facts.scope.workspaceId : facts.workspace;
  const where =
    workspaceId === undefined
      ? t("guardrails.runs.instanceWide")
      : (() => {
          const name = words.workspaceName(workspaceId);
          return name === undefined
            ? t("guardrails.runs.inSomeWorkspace")
            : t("guardrails.runs.inWorkspace", { name });
        })();
  return facts.setByOperator ? t("guardrails.runs.setByOperator", { where }) : where;
}
