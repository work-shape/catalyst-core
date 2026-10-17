import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationOutcome } from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { readProposalRefusal, type AgentProposalRefusal } from "./agent-proposal-model";
import { instanceSentence } from "./build-refusals";

/** The pending proposal as the page reads it beside the live agent. */
interface AgentProposal {
  /** The proposal's newest revision: the one the person reads, and Apply names. */
  revision: number;
  /** The agent was saved since the proposal was based on it: Apply refuses it. */
  stale: boolean;
  /** The whole definition of the agent as proposed. */
  config: Record<string, unknown>;
}

/** What the last Apply or Discard answered, for the page to say. */
type AgentProposalAnswer =
  { kind: AgentProposalRefusal } | { kind: "waits" } | { kind: "failed"; message: string };

/** An answer and the proposal revision the decision was sent for. */
interface AnsweredRevision {
  sent: number;
  answer: AgentProposalAnswer | undefined;
}

/**
 * The answer that still holds for the proposal on the page. "Changed" is about a newer
 * revision than the one sent, which the page reads after it; every other answer is about the
 * revision sent, so a newer proposal the agent wrote meanwhile is shown as it is.
 */
export function answerOfRevision(
  answered: AnsweredRevision | undefined,
  revision: number
): AgentProposalAnswer | undefined {
  if (answered?.answer?.kind === "changed") {
    return revision > answered.sent ? answered.answer : undefined;
  }
  return answered?.sent === revision ? answered.answer : undefined;
}

/** Apply or Discard: what a person decides on a proposal. */
type ProposalDecision = keyof NonNullable<AgentProposalState["decide"]>;

/** The proposal on the agent page, with Apply and Discard. */
export interface AgentProposalState {
  proposal: AgentProposal;
  /** Apply and Discard. Absent for a reader who may not change the agent. */
  decide?: {
    apply(): Promise<void>;
    discard(): Promise<void>;
  };
  /** The decision on its way. */
  busy: ProposalDecision | undefined;
  answer: AgentProposalAnswer | undefined;
}

/**
 * Makes one decision on a proposal and says how it went. A decision that was made reads the
 * page again; a refusal reads the proposal again, so the page shows what holds now: a newer
 * proposal, a stale one or none.
 */
export async function decideProposal(input: {
  call(): Promise<OperationOutcome<unknown>>;
  /** Reads the agent again after an Apply: the page starts again from the live agent. */
  done(): Promise<unknown>;
  /** Reads the proposal again. */
  reread(): Promise<unknown>;
  failedMessage: string;
}): Promise<AgentProposalAnswer | undefined> {
  let outcome: OperationOutcome<unknown>;
  try {
    outcome = await input.call();
  } catch (error) {
    await input.reread().catch(() => undefined);
    const refusal = readProposalRefusal(error);
    if (refusal !== undefined) return { kind: refusal };
    return { kind: "failed", message: instanceSentence(error) ?? input.failedMessage };
  }
  if (outcome.status !== "done") return { kind: "waits" };
  await input.done().catch(() => undefined);
  return undefined;
}

/**
 * The pending proposal of the conversation in the dock for the agent on the page, where it has
 * one. It is read again with every read of the assets, which the dock drops whenever its agent
 * saves, so a newer proposal shows as it is written. A conversation of anybody else answers as
 * missing, which is no proposal here.
 */
export function useAgentProposal(input: {
  /** The agent on the page. Absent for a new one, which has no proposal. */
  agent: string | undefined;
  /** The reader may change the agent: Apply and Discard are offered. */
  canDecide: boolean;
  /** Reads the agent again after an Apply. */
  reload(): Promise<unknown>;
}): AgentProposalState | undefined {
  const { apiBaseUrl, authScope, client, dockConversationId } = useSettingsPage();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ProposalDecision>();
  const [answered, setAnswered] = useState<AnsweredRevision>();
  const { agent, canDecide, reload } = input;
  const address =
    agent === undefined || dockConversationId === undefined
      ? undefined
      : { name: agent, conversationId: dockConversationId };
  const queryKey = [
    ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
    "agent-proposal",
    agent ?? "",
    dockConversationId ?? ""
  ];
  const query = useQuery({
    queryKey,
    enabled: address !== undefined && canDecide,
    queryFn: async ({ signal }): Promise<AgentProposal | null> => {
      if (address === undefined) return null;
      try {
        const { draft } = await client.agents.draft.get({ params: { name: address.name }, signal });
        return draft;
      } catch (error) {
        // The conversation is somebody else's, or gone: it has no proposal for this reader.
        if (apiErrorCode(error) === "NOT_FOUND") return null;
        throw error;
      }
    },
    retry: false
  });
  const proposal = query.data ?? undefined;
  if (!canDecide || address === undefined || proposal === undefined) return undefined;

  const reread = () => queryClient.invalidateQueries({ queryKey });
  const decide = async (kind: ProposalDecision) => {
    // The revision on screen when the person decided: what the answer is about.
    const sent = proposal.revision;
    setBusy(kind);
    setAnswered(undefined);
    const next = await decideProposal({
      call: () =>
        kind === "apply"
          ? client.assets.publish({
              params: { kind: "agent", name: address.name },
              body: { revision: sent }
            })
          : client.agents.draft.discard({
              params: { name: address.name },
              body: { expectedRevision: sent }
            }),
      done: async () => {
        queryClient.setQueryData(queryKey, null);
        if (kind === "apply") await reload();
      },
      reread,
      failedMessage: t("agentProposal.failed")
    });
    setAnswered({ sent, answer: next });
    setBusy(undefined);
  };
  return {
    proposal,
    ...(canDecide
      ? { decide: { apply: () => decide("apply"), discard: () => decide("discard") } }
      : {}),
    busy,
    answer: answerOfRevision(answered, proposal.revision)
  };
}
