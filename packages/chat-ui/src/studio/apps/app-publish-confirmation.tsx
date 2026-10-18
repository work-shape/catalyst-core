import { useState, type ReactNode } from "react";
import { appAudienceSchema } from "@work-shape/catalyst-api-client";
import { SkeletonList } from "@work-shape/catalyst-ui";
import { narrativeHolds, PublishNarrativeReadLead } from "../../shared/publish-narrative";
import { useAppPublishNarrative, type AppAudience } from "./app-data";
import { AppAudienceChange, AppAudienceQuestion } from "./app-publish-question";
import { useAppsHost } from "./apps-host";

// "For whom?" on an agent's publish of an App (SHARE-1). The agent may suggest an audience; the
// person's confirmation asks the question with that suggestion chosen where the instance offers
// it, and what they choose is what is published. Nothing goes live before Allow.

/** An agent's publish of an App, as its waiting call names it. */
export interface AppPublishCall {
  app: string;
  revision: number;
  /** Absent where the call names none: the open workspace's App is meant. */
  workspaceId: string | undefined;
  /** The audience the agent suggested, if it gave one. */
  suggested: AppAudience | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The App publish a waiting call is, or nothing for any other call. */
export function appPublishCall(decision: {
  operationId: string;
  inputPreview: unknown;
}): AppPublishCall | undefined {
  const input = decision.inputPreview;
  if (decision.operationId !== "assets.publish" || !isRecord(input) || input.kind !== "app") {
    return undefined;
  }
  const { name, revision, workspaceId } = input;
  if (typeof name !== "string" || typeof revision !== "number") return undefined;
  const suggested = appAudienceSchema.safeParse(input.audience);
  return {
    app: name,
    revision,
    workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
    suggested: suggested.success ? suggested.data : undefined
  };
}

/** What the confirmation card holds for an App publish: the question, and what Allow sends. */
export interface AppPublishConfirmationAsk {
  node: ReactNode;
  /** The audience shown, which Allow sends. */
  audience: AppAudience | undefined;
  /** The sentence for the audience shown is there: Allow may be clicked. */
  ready: boolean;
}

/**
 * Reads the question for an agent's App publish. The first read asks what the instance proposes
 * and which choices it offers this person; where the agent's suggestion is among them, it is
 * chosen and read next. A suggestion the person may not make is never read: the instance's own
 * proposal stays.
 */
export function useAppPublishConfirmation(
  call: AppPublishCall,
  disabled: boolean
): AppPublishConfirmationAsk {
  const host = useAppsHost();
  const workspaceId = call.workspaceId ?? host?.workspace?.id ?? "";
  const [read, setRead] = useState<AppAudience>();
  const [settled, setSettled] = useState(false);
  const question = useAppPublishNarrative(workspaceId, call.app, call.revision, read);
  const offer = question.audience;
  if (!settled && offer) {
    setSettled(true);
    if (
      call.suggested !== undefined &&
      call.suggested !== offer.selected &&
      offer.choices.includes(call.suggested)
    ) {
      setRead(call.suggested);
    }
  }
  const selected = settled ? (read ?? offer?.selected) : undefined;
  const ready =
    offer !== undefined && offer.selected === selected && !narrativeHolds(question.narrative);
  return {
    audience: selected,
    ready,
    node: (
      <div className="grid min-w-0 gap-3" data-testid="app-publish-confirmation">
        {offer && selected !== undefined ? (
          <AppAudienceQuestion
            offer={offer}
            selected={selected}
            workspaceName={offer.workspaceName ?? host?.workspace?.name ?? ""}
            disabled={disabled}
            onChange={setRead}
          />
        ) : (
          <SkeletonList rows={2} className="w-full" />
        )}
        <AppAudienceChange offer={offer} selected={selected} />
        <PublishNarrativeReadLead read={question.narrative} />
      </div>
    )
  };
}
