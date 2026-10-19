import { Inbox } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Card,
  Chip,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  FoldedText,
  KeyValue,
  KeyValueList,
  Spinner,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  appPublishCall,
  useAppPublishConfirmation,
  type AppPublishCall,
  type AppPublishConfirmationAsk
} from "../../studio/apps/app-publish-confirmation";
import {
  useWorkflowPublishConfirmation,
  workflowPublishCall,
  type WorkflowPublishCall
} from "../../studio/workflows/workflow-publish-confirmation";
import { workspaceRoutePath } from "../../shared/routes";
import { useApprovalRevisionHost } from "./approval-revision-host";
import { ApprovalRequestCard } from "./approval-request-card";
import { formatApprovalDate } from "./approval-request-model";
import { dataStoreRowChange } from "./data-store-row-change";
import { knowledgeAddFilesCall, useKnowledgeAddFilesAsk } from "./knowledge-add-files";
import { MailSendDecisionView, mailSendDecisionPreview } from "./mail-send-decision";
import { CallInputs, RowChangeInputs } from "./operation-call-body";
import {
  useToolDecisionDecide,
  useWaitingOperationRunQuery,
  type ToolDecisionInput
} from "./tool-decision-api";
import {
  agentSaveSummary,
  DECLINE_REASON_MAX_CHARS,
  toolDecisionInputRows,
  type AgentSaveSummary,
  type ToolDecision,
  type ToolDecisionFailure,
  type ToolDecisionOutcome
} from "./tool-decision-model";

const OUTCOME: Record<ToolDecisionOutcome, { label: TranslationKey; tone: "info" | "success" }> = {
  confirmed: { label: "toolDecisionAllowed", tone: "success" },
  declined: { label: "toolDecisionDenied", tone: "info" }
};

const FAILURE: Record<ToolDecisionFailure, TranslationKey> = {
  failed: "toolDecisionFailed",
  already_decided: "toolDecisionAlreadyDecided",
  expired: "toolDecisionExpired",
  not_yours: "toolDecisionNotYours"
};

/**
 * The host's own card on an agent's call that waits for a decision. A confirmation asks the
 * person the run acts for to allow or deny the call as it will run; an approval shows the
 * request that somebody else decides.
 */
export function ToolDecisionCard({
  decision,
  title,
  toolName
}: {
  decision: ToolDecision;
  /** The call's label, as the tool call's own line names it. */
  title: string;
  toolName: string;
}) {
  return decision.mode === "approval" ? (
    <ToolApprovalWait decision={decision} />
  ) : (
    <ToolConfirmation decision={decision} title={title} toolName={toolName} />
  );
}

function ToolConfirmation({
  decision,
  title,
  toolName
}: {
  decision: ToolDecision;
  title: string;
  toolName: string;
}) {
  const answer = useToolDecisionDecide(decision.operationRunId);
  const host = useApprovalRevisionHost();
  // A confirmation that waits in the person's Inbox names its item there (OP-4b). Until the
  // call's run says where it waits, the buttons are held.
  const run = useWaitingOperationRunQuery(decision.operationRunId);
  const inboxItemId = run.data?.approvalRequestId;
  if (inboxItemId) {
    return (
      <ToolInboxWaitView
        decision={decision}
        title={title}
        inboxItemId={inboxItemId}
        onOpenInboxItem={host?.openInboxItem}
      />
    );
  }
  const shown = run.isPending ? { ...answer, pending: true } : answer;
  const props = { decision, title, toolName, answer: shown };
  // An agent's publish of an App asks "For whom?" first (SHARE-1); a Workflow's publish says
  // what goes live, and a Knowledge Base's add_files which files it adds (ACCEPT-FIX-11 C1).
  const appCall = appPublishCall(decision);
  if (appCall) return <AppPublishDecisionCard call={appCall} {...props} />;
  const workflowCall = workflowPublishCall(decision);
  if (workflowCall) return <WorkflowPublishDecisionCard call={workflowCall} {...props} />;
  const addedFiles = knowledgeAddFilesCall(decision);
  if (addedFiles) return <KnowledgeAddFilesDecisionCard files={addedFiles} {...props} />;
  return <ToolDecisionCardView {...props} />;
}

/** The confirmation of an agent's Workflow publish: Allow waits for the sentence on it. */
function WorkflowPublishDecisionCard({
  call,
  ...props
}: Parameters<typeof ToolDecisionCardView>[0] & { call: WorkflowPublishCall }) {
  return <ToolDecisionCardView {...props} ask={useWorkflowPublishConfirmation(call)} />;
}

/** The confirmation of an add_files call: the Knowledge Base and the files by their names. */
function KnowledgeAddFilesDecisionCard({
  files,
  ...props
}: Parameters<typeof ToolDecisionCardView>[0] & {
  files: NonNullable<ReturnType<typeof knowledgeAddFilesCall>>;
}) {
  return (
    <ToolDecisionCardView
      {...props}
      ask={useKnowledgeAddFilesAsk(files, props.decision.targetTitle)}
    />
  );
}

/** The confirmation of an agent's App publish: the person's "For whom?" is what Allow sends. */
function AppPublishDecisionCard({
  call,
  ...props
}: Parameters<typeof ToolDecisionCardView>[0] & { call: AppPublishCall }) {
  const ask = useAppPublishConfirmation(
    call,
    props.answer.pending || props.answer.decided !== undefined
  );
  return <ToolDecisionCardView {...props} ask={ask} />;
}

/**
 * A confirmation of a run nobody watched, which waits in its person's Inbox: the conversation
 * shows that it waits and leads to the item, the only place to answer it (OP-4b).
 */
export function ToolInboxWaitView({
  decision,
  title,
  inboxItemId,
  onOpenInboxItem
}: {
  decision: Pick<ToolDecision, "expiresAt">;
  title: string;
  inboxItemId: string;
  /** Opens the item in this tab; without it the link loads its address. */
  onOpenInboxItem?(itemId: string): void;
}) {
  const { locale, t } = useTranslation();
  return (
    <Card
      className="grid min-w-0 gap-2 px-4 py-3 text-body"
      role="group"
      aria-label={t("toolDecisionLabel", { title })}
      data-testid="tool-decision-card"
      data-mode="inbox"
    >
      <div className="grid min-w-0 gap-0.5">
        <p className="font-medium text-foreground wrap-anywhere">{title}</p>
        <p className="text-caption text-muted-foreground">{t("toolDecisionInInbox")}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <a
            href={workspaceRoutePath({ kind: "inbox-item", itemId: inboxItemId })}
            data-testid="tool-decision-inbox-link"
            onClick={(event) => {
              if (!onOpenInboxItem || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenInboxItem(inboxItemId);
            }}
          >
            <Inbox aria-hidden="true" />
            {t("toolDecisionOpenInInbox")}
          </a>
        </Button>
        <span
          className="ml-auto text-caption text-muted-foreground"
          data-testid="tool-decision-expires"
        >
          {t("toolDecisionExpires", { date: formatApprovalDate(decision.expiresAt, locale) })}
        </span>
      </div>
    </Card>
  );
}

export interface ToolDecisionAnswer {
  decide(decision: ToolDecisionInput): void;
  pending: boolean;
  /** The answer the server took, until the run's record of it arrives. */
  decided: ToolDecisionInput | undefined;
  failure: ToolDecisionFailure | undefined;
}

/** The confirmation as drawn: the call, its input, the expiry, and Allow and Deny. */
export function ToolDecisionCardView({
  decision,
  title,
  toolName,
  answer,
  ask
}: {
  decision: ToolDecision;
  title: string;
  toolName: string;
  answer: ToolDecisionAnswer;
  /** A question the call asks before Allow, as "For whom?" of an App publish. */
  ask?: AppPublishConfirmationAsk;
}) {
  const { locale, t } = useTranslation();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  // The answer shows until the run records it, which takes the card away in every tab.
  const outcome = takenOutcome(answer.decided);
  const outcomeReason = answer.decided?.reason;
  // Where the card asks "For whom?", the person's answer stands for the agent's suggestion.
  const rows = toolDecisionInputRows(decision.inputPreview).filter(
    (row) => ask === undefined || row.key !== "audience"
  );
  // A row write of a Data Store asks what it changes in one question and lists its rows.
  const rowChange = dataStoreRowChange(
    decision.operationId,
    decision.inputPreview,
    decision.targetTitle
  );

  const inputs = rowChange ? (
    <RowChangeInputs change={rowChange} />
  ) : (
    <CallInputs
      call={{ inputs: rows, inputFieldCount: rows.length, inputRemoved: false }}
      hiddenFields={0}
    />
  );
  // A save of an agent says in words what it writes; its definition is a technical detail.
  const agent = agentSaveSummary(decision, locale);
  // A mail shows as it will go out, rendered by the server: its input is a technical detail.
  const mail = mailSendDecisionPreview(decision);
  const inputsInDetails = ask !== undefined || agent !== undefined || mail !== undefined;

  function deny(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmed = reason.trim();
    answer.decide({ decision: "decline", ...(trimmed ? { reason: trimmed } : {}) });
  }

  return (
    <Card
      className="grid min-w-0 gap-3 px-4 py-3 text-body"
      role="group"
      aria-label={t("toolDecisionLabel", { title })}
      data-testid="tool-decision-card"
      data-mode="confirm"
      data-outcome={outcome}
    >
      <div className="grid min-w-0 gap-0.5">
        <p className="font-medium text-foreground wrap-anywhere">{title}</p>
        {outcome ? null : (
          <p className="text-caption text-muted-foreground">{t("toolDecisionWaiting")}</p>
        )}
      </div>
      {outcome ? (
        <Banner
          layout="line"
          tone={OUTCOME[outcome].tone}
          data-testid="tool-decision-outcome"
          data-outcome={outcome}
        >
          {t(OUTCOME[outcome].label)}
          {outcome === "declined" && outcomeReason ? (
            <span className="block text-caption text-muted-foreground wrap-anywhere">
              {t("operations.callOutcomeReason", { reason: outcomeReason })}
            </span>
          ) : null}
        </Banner>
      ) : null}
      {ask && !outcome ? ask.node : null}
      {/* A call that asks its own question, as an App publish asks "For whom?", says in that
          question what it does: its raw inputs are technical details then. */}
      {agent ? <AgentSummary agent={agent} /> : null}
      {mail ? <MailSendDecisionView mail={mail} /> : null}
      {inputsInDetails ? null : inputs}
      <Disclosure data-testid="tool-decision-details">
        <DisclosureTrigger>{t("operations.callDetails")}</DisclosureTrigger>
        <DisclosureContent>
          {inputsInDetails ? <div className="pt-1">{inputs}</div> : null}
          <KeyValueList className="pt-1">
            <KeyValue label={t("operations.operation")} data-field="operation">
              <span className="font-mono text-code wrap-anywhere">{decision.operationId}</span>
            </KeyValue>
            <KeyValue label={t("operations.fieldToolName")} data-field="tool">
              <span className="font-mono text-code wrap-anywhere">{toolName}</span>
            </KeyValue>
          </KeyValueList>
        </DisclosureContent>
      </Disclosure>
      {outcome ? null : (
        <form className="grid min-w-0 gap-2" onSubmit={deny}>
          {reasonOpen ? (
            <Field label={t("toolDecisionReason")} hint={t("toolDecisionReasonHint")} optional>
              <Textarea
                autoFocus
                rows={2}
                maxLength={DECLINE_REASON_MAX_CHARS}
                value={reason}
                disabled={answer.pending}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={answer.pending || (ask !== undefined && !ask.ready)}
              onClick={() =>
                answer.decide({
                  decision: "confirm",
                  ...(ask?.audience === undefined ? {} : { audience: ask.audience })
                })
              }
            >
              {t("toolDecisionAllow")}
            </Button>
            <Button type="submit" size="sm" variant="outline" disabled={answer.pending}>
              {t("toolDecisionDeny")}
            </Button>
            {reasonOpen ? null : (
              <Button
                type="button"
                size="sm"
                variant="link"
                disabled={answer.pending}
                onClick={() => setReasonOpen(true)}
              >
                {t("toolDecisionAddReason")}
              </Button>
            )}
            {answer.pending ? <Spinner size="sm" /> : null}
            <span
              className="ml-auto text-caption text-muted-foreground"
              data-testid="tool-decision-expires"
            >
              {t("toolDecisionExpires", { date: formatApprovalDate(decision.expiresAt, locale) })}
            </span>
          </div>
          {answer.failure ? (
            <p role="alert" className="text-caption text-destructive">
              {t(FAILURE[answer.failure])}
            </p>
          ) : null}
        </form>
      )}
    </Card>
  );
}

/** The agent a save writes, as a person reads it: name, instructions, skills and tools. */
function AgentSummary({ agent }: { agent: AgentSaveSummary }) {
  const { t } = useTranslation();
  const names = (list: string[]) =>
    list.length === 0 ? (
      t("toolDecisionAgentNone")
    ) : (
      <span className="flex min-w-0 flex-wrap gap-1">
        {list.map((name) => (
          <Chip key={name} size="sm">
            {name}
          </Chip>
        ))}
      </span>
    );
  return (
    <KeyValueList data-testid="tool-decision-agent">
      <KeyValue label={t("toolDecisionAgentName")} data-field="agent-name">
        <span className="wrap-anywhere">{agent.title}</span>
      </KeyValue>
      {agent.instructions ? (
        <KeyValue label={t("toolDecisionAgentInstructions")} data-field="agent-instructions">
          <FoldedText>{agent.instructions}</FoldedText>
        </KeyValue>
      ) : null}
      <KeyValue label={t("toolDecisionAgentSkills")} data-field="agent-skills">
        {names(agent.skills)}
      </KeyValue>
      <KeyValue label={t("toolDecisionAgentTools")} data-field="agent-tools">
        {names(agent.tools)}
      </KeyValue>
    </KeyValueList>
  );
}

function takenOutcome(decided: ToolDecisionInput | undefined): ToolDecisionOutcome | undefined {
  if (!decided) return undefined;
  return decided.decision === "confirm" ? "confirmed" : "declined";
}

/**
 * A call that waits for somebody else's approval: the request's own card, under one line that
 * says the agent waits for it.
 */
function ToolApprovalWait({ decision }: { decision: ToolDecision }) {
  const { t } = useTranslation();
  const run = useWaitingOperationRunQuery(decision.operationRunId);
  const requestId = run.data?.approvalRequestId;
  return (
    <div className="grid min-w-0 gap-2" data-testid="tool-decision-card" data-mode="approval">
      <p className="text-caption text-muted-foreground">{t("toolDecisionAwaitingApproval")}</p>
      {requestId ? <ApprovalRequestCard requestId={requestId} /> : null}
    </div>
  );
}
