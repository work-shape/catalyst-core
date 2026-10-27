import { useState, type ReactNode } from "react";
import { appAudienceSchema } from "@work-shape/catalyst-api-client";
import { KeyValueList, SkeletonList } from "@work-shape/catalyst-ui";
import {
  narrativeHolds,
  PublishNarrativeReadLead,
  type PublishNarrativeRead
} from "../../shared/publish-narrative";
import {
  useAppPublishData,
  useAppPublishNarrative,
  useAppPublishTogether,
  type AppAudience,
  type AppAudienceOffer,
  type AppPublishDataRead,
  type AppPublishTogetherRead
} from "./app-data";
import { AppPublishDataView } from "./app-publish-data";
import { AppPublishTogetherView, appPublishTogetherReady } from "./app-publish-together";
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
  /** The Workflows the call makes live with the App, by name (DP-3). */
  workflows: readonly string[];
  /** The Data Stores the call publishes with the App, by name (GOLIVE-1). */
  dataStores: readonly string[];
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
  const names = (list: unknown) =>
    Array.isArray(list)
      ? list.flatMap((entry) =>
          isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []
        )
      : [];
  return {
    app: name,
    revision,
    workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
    suggested: suggested.success ? suggested.data : undefined,
    workflows: names(input.workflows),
    dataStores: names(input.dataStores)
  };
}

/**
 * The name the card gives the App's workspace. The open workspace is named as the interface
 * shows it, a Personal Workspace after its owner; the name the instance stores, which is the
 * same "Personal workspace" for everyone, names only a workspace other than the open one.
 */
export function appWorkspaceName(
  workspaceId: string | undefined,
  open: { id: string; name: string } | undefined,
  stored: string | undefined
): string {
  if (open && (workspaceId === undefined || workspaceId === open.id)) return open.name;
  return stored ?? open?.name ?? "";
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
 * Whether Allow may be clicked: the answer for the audience shown is in, with its sentence, and
 * where the revision reads stored data, the lines on who sees it. A failed read holds it too.
 */
export function appPublishConfirmationReady(input: {
  offer: AppAudienceOffer | undefined;
  selected: AppAudience | undefined;
  narrative: PublishNarrativeRead;
  readsStoredData: boolean | undefined;
  storedData: AppPublishDataRead;
  /** The stores and Workflows the call makes live with the App. Absent where it names none. */
  together?: AppPublishTogetherRead;
}): boolean {
  if (input.offer === undefined || input.offer.selected !== input.selected) return false;
  if (input.together && !appPublishTogetherReady(input.together)) return false;
  if (narrativeHolds(input.narrative) || input.readsStoredData === undefined) return false;
  return !input.readsStoredData || input.storedData.status === "ready";
}

/**
 * The question as the card shows it: "For whom?", who has it now where that changes, the
 * instance's sentence and, where the revision reads stored data, who sees it under the choice
 * shown, the same lines as the Publish dialog's.
 */
export function AppPublishConfirmationView({
  offer,
  selected,
  workspaceName,
  narrative,
  storedData,
  together,
  disabled,
  onChange
}: {
  offer: AppAudienceOffer | undefined;
  selected: AppAudience | undefined;
  /** The name of the App's workspace as the interface shows it. */
  workspaceName: string;
  narrative: PublishNarrativeRead;
  /** The lines on stored data. Absent where the revision reads none. */
  storedData: AppPublishDataRead | undefined;
  /** The Workflows the call makes live with the App. Absent where it names none. */
  together?: AppPublishTogetherRead | undefined;
  disabled: boolean;
  onChange(audience: AppAudience): void;
}) {
  // The offer names the people of the audience it was read for; for another choice it waits.
  const audienceLabel = offer && offer.selected === selected ? offer.label : undefined;
  return (
    <div className="grid min-w-0 gap-3" data-testid="app-publish-confirmation">
      {offer && selected !== undefined ? (
        <AppAudienceQuestion
          offer={offer}
          selected={selected}
          workspaceName={workspaceName}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <SkeletonList rows={2} className="w-full" />
      )}
      <AppAudienceChange offer={offer} selected={selected} workspaceName={workspaceName} />
      <PublishNarrativeReadLead read={narrative} />
      {together ? <AppPublishTogetherView read={together} /> : null}
      {storedData ? (
        <KeyValueList>
          <AppPublishDataView
            read={storedData}
            audienceLabel={audienceLabel}
            audiencePeople={selected === "self" ? undefined : offer?.people}
            audiencePending={offer !== undefined && audienceLabel === undefined}
          />
        </KeyValueList>
      ) : null}
    </div>
  );
}

/**
 * Reads the question for an agent's App publish. The first read asks what the instance proposes
 * and which choices it offers this person; where the agent's suggestion is among them, it is
 * chosen and read next. A suggestion the person may not make is never read: the instance's own
 * proposal stays. Who sees which stored data is read only for a revision with a reading `sql`
 * action, so a plain App confirms on an instance without Data Stores.
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
  const readsStoredData = question.readsStoredData;
  const storedData = useAppPublishData(call.app, call.revision, readsStoredData === true);
  const selected = settled ? (read ?? offer?.selected) : undefined;
  // The stores and Workflows the agent named go live with the App on Allow: each as the
  // review shows it.
  const names = call.workflows.length + call.dataStores.length > 0;
  const reviewed = useAppPublishTogether(call.app, call.revision, names);
  const together = names
    ? {
        ...reviewed,
        workflows: reviewed.workflows.filter(({ name }) => call.workflows.includes(name)),
        // A store still being updated is waited for though the agent names it not.
        dataStores: reviewed.dataStores.filter(
          ({ name, pending }) => !pending || call.dataStores.includes(name)
        )
      }
    : undefined;
  return {
    audience: selected,
    ready: appPublishConfirmationReady({
      offer,
      selected,
      narrative: question.narrative,
      readsStoredData,
      storedData,
      ...(together ? { together } : {})
    }),
    node: (
      <AppPublishConfirmationView
        offer={offer}
        selected={selected}
        workspaceName={appWorkspaceName(call.workspaceId, host?.workspace, offer?.workspaceName)}
        narrative={question.narrative}
        storedData={readsStoredData ? storedData : undefined}
        together={together}
        disabled={disabled}
        onChange={setRead}
      />
    )
  };
}
