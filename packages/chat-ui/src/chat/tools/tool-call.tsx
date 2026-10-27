import { ToolDecisionCard } from "../approvals/tool-decision-card";
import { useToolDecision } from "../approvals/tool-decision-context";
export { ToolDecisionsProvider } from "../approvals/tool-decision-context";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { RUN_AGENT_TOOL_NAME } from "@work-shape/catalyst-core";
import { cn } from "@work-shape/catalyst-ui";
import { Wrench } from "lucide-react";
import {
  isToolDisplayPayload,
  readToolDisplayPayloadFromToolResult,
  ToolDisplayWidgetNode,
  useToolDisplayWidget
} from "../../shared/domain-ui-widgets";
import { useTranslation } from "../../shared/i18n";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  CONNECTION_PROPOSE_TOOL_NAME,
  readConnectionDraft,
  readConnectionProposal
} from "../../studio/build-area/connection-draft";
import { ConnectionDraftCard } from "../../studio/build-area/connection-draft-card";
import { useConnectionDraftHost } from "../../studio/build-area/connection-draft-host";
import { ConnectionConnectCard } from "../../studio/build-area/connection-connect-card";
import { connectCardOfRefusal } from "../../studio/build-area/connection-connect-card-model";
import {
  CONNECTION_OFFER_TOOL_NAME,
  ConnectionGiveCard,
  readConnectionOffer
} from "../../studio/build-area/connection-give-card";
import { PageSaveCard } from "../../studio/pages/page-card";
import { AssetPreviewCard, previewedDraftOfCall } from "../../studio/pages/asset-preview";
import { builtPageName, isOpenToolName, readPageSave } from "../../studio/pages/page-save";
import {
  PreviewCaptureOutcomeView,
  readPreviewCapture
} from "../../studio/pages/preview-capture-picture";
import { ApprovalRequestCard } from "../approvals/approval-request-card";
import { readApprovalRequestDisplay } from "../approvals/approval-request-model";
import { useConnectionToolSubject } from "../assistant/tool-subjects";
import { AssetOpenedLine } from "../conversation/conversation-subject";
import { appSavedByCall, standingAssetOpen } from "../conversation/subject-run";
import { AppCard } from "../../studio/apps/app-card";
import { useFoldedCard } from "../conversation/card-fold-context";
import { ToolArtifactList } from "../files/artifact-download-card";
import {
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs,
  readWorkspacePromotedArtifactsData
} from "./tool-artifacts";
import {
  CompactToolCall,
  DisplayDataPart,
  DisplayToolCall,
  SidePanelDataPart,
  SidePanelToolCall,
  ToolCallHead
} from "./tool-call-presentation";
import {
  formatDetails,
  getToolSummary,
  hasRenderedNode,
  readToolDisplayProjection,
  readToolErrorSentence,
  toolDetailSections,
  toolStatusLabel,
  toolUiState
} from "./tool-call-projection";
import { useToolDisplayPanel } from "./tool-display-panel";
import { readDisplayMode, renderBuiltInDisplay } from "./tool-display-rendering";
import { ToolSurfaceList } from "./tool-surface-card";
import { SubagentCard } from "../subagents/subagent-card";
import { readWorkspacePromotedSurfacesData } from "./tool-surfaces";
import { projectWorkspaceToolDisplay } from "./workspace-tool-display";
export { ToolCallFoldLabel } from "./tool-call-presentation";
export {
  readToolActionLabel,
  readToolDetailSections,
  readToolDisplayProjection
} from "./tool-call-projection";

// Whoever renders tool calls outside the thread gives them their subjects with this.
export { ToolSubjectsProvider } from "../assistant/tool-subjects";

interface DataPartProps {
  name: string;
  data: unknown;
  autoPreviewSurfaces?: boolean;
  displayPresentation?: "full" | "summary";
}

export function ToolCallPart({
  toolName,
  toolCallId,
  args,
  argsText,
  result,
  isError,
  status,
  displayPresentation = "full"
}: ToolCallMessagePartProps & {
  displayPresentation?: "full" | "summary";
}) {
  const { locale, t } = useTranslation();
  const displayPanel = useToolDisplayPanel();
  const displayWidget = useToolDisplayWidget();
  const state = toolUiState({ isError, result, status, toolName });
  const decision = useToolDecision(toolCallId);
  const connectionHost = useConnectionDraftHost();
  const display = readToolDisplayPayloadFromToolResult(result);
  // Platform-owned and resolved before the client widget registry: the card
  // decides a change to the instance, so a client assembly must not replace it.
  const approvalRequest = readApprovalRequestDisplay(display);
  const renderedDisplay =
    display && displayWidget && !approvalRequest
      ? displayWidget({
          display,
          locale,
          source: "tool-result",
          toolName,
          toolCallId,
          result
        })
      : undefined;
  const builtInDisplay =
    display && !hasRenderedNode(renderedDisplay) ? renderBuiltInDisplay(display) : undefined;
  const panelDisplayNode = display ? (
    <ToolDisplayWidgetNode
      display={display}
      fallback={builtInDisplay}
      locale={locale}
      result={result}
      source="tool-result"
      toolCallId={toolCallId}
      toolName={toolName}
    />
  ) : (
    builtInDisplay
  );
  const hasDisplay = hasRenderedNode(renderedDisplay) || hasRenderedNode(builtInDisplay);
  const displayMode = readDisplayMode(display);
  const workspaceProjection = projectWorkspaceToolDisplay({ args, result, toolName });
  // An earlier save of an App or preview of a folder: the newest one is the card, and this one
  // is a line in the run's work that says what it did (APPCARD-1).
  const folded = useFoldedCard(toolCallId);
  const projected = readToolDisplayProjection({ args, result, toolName, locale });
  const toolDisplay = folded
    ? {
        ...projected,
        title: t(folded === "app_draft" ? "apps.cardFoldedDraft" : "pages.cardFoldedPreview")
      }
    : projected;
  const foldedName = folded ? foldedCardName({ toolName, args, result, isError }, t) : undefined;
  const subject = useConnectionToolSubject(toolName);
  const detailSections = [
    // The line of the call says what was touched in words. The name the agent called stays
    // here for whoever builds the agent.
    ...(subject ? [{ label: t("toolTechnicalName"), value: toolName, kind: "name" as const }] : []),
    ...(workspaceProjection?.sections ??
      toolDetailSections({
        args,
        argsText,
        toolName,
        result,
        labels: { input: t("toolInput"), output: t("toolOutput") }
      }))
  ];
  const artifacts = readToolArtifactRefs(result);
  const surfacedArtifacts = readSurfacedToolArtifactRefs(result, toolName);
  // A failed call says why in its own sentence, where the output is one; the output itself
  // stays under the technical details.
  const summary =
    workspaceProjection?.summary ??
    getToolSummary(result, t) ??
    (state === "failed" ? readToolErrorSentence(result) : undefined);
  const statusLabel = toolStatusLabel(state, t);
  const actionLabel = foldedName ?? workspaceProjection?.actionLabel ?? toolDisplay.actionLabel;

  // The run waits for a decision on this call, or took one and the call has not answered yet.
  if (decision && state === "running") {
    return (
      <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
        <ToolDecisionCard decision={decision} title={toolDisplay.title} toolName={toolName} />
      </div>
    );
  }

  // A refused call started no subagent and is drawn as any failed call.
  if (toolName === RUN_AGENT_TOOL_NAME && state !== "failed") {
    return (
      <SubagentCard
        toolCallId={toolCallId}
        description={typeof args.description === "string" ? args.description : undefined}
        result={result}
      />
    );
  }

  if (isOpenToolName(toolName) && !folded) {
    return <PageSaveCard args={args} result={result} failed={state === "failed"} />;
  }

  // The newest save of an App is its card, with "Open" and "Publish" (APPCARD-1).
  const appSaved = folded ? undefined : appSavedByCall({ toolName, result, isError });
  if (appSaved) {
    return <AppCard saved={appSaved} />;
  }

  // A save of a draft the person sees beside the chat, such as a form page: its card opens it.
  const previewed = folded ? undefined : previewedDraftOfCall({ toolName, result, isError });
  if (previewed) {
    return <AssetPreviewCard draft={previewed} />;
  }

  const opened = standingAssetOpen({ toolName, toolCallId, result, isError });
  if (opened) {
    return <AssetOpenedLine open={opened} />;
  }

  // A call of a personal Connection the person has not signed in to: the Connect card stands in
  // place of the refusal, for the person whose conversation it is (CHAT-CONN-2b).
  const connectRefusal =
    state === "failed" && connectionHost?.ownsConversation
      ? connectCardOfRefusal(result)
      : undefined;
  if (connectRefusal) {
    return <ConnectionConnectCard card={connectRefusal} refused />;
  }

  // The agent's draft of REST API tools: a card whose button opens the approval list. Its
  // proposal of a new Connection: a card whose button opens the New connection dialog.
  const connectionDraft =
    state !== "completed"
      ? undefined
      : toolName === CONNECTION_DRAFT_TOOL_NAME
        ? readConnectionDraft(result)
        : toolName === CONNECTION_PROPOSE_TOOL_NAME
          ? readConnectionProposal(result)
          : undefined;
  if (connectionDraft) {
    return <ConnectionDraftCard draft={connectionDraft} />;
  }

  // The agent's offer of a Connection's tools: a card whose button gives them to an agent.
  const connectionOffer =
    toolName === CONNECTION_OFFER_TOOL_NAME && state === "completed"
      ? readConnectionOffer(result)
      : undefined;
  if (connectionOffer) {
    return <ConnectionGiveCard offer={connectionOffer} />;
  }

  if (approvalRequest) {
    return (
      <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
        <ApprovalRequestCard requestId={approvalRequest.requestId} />
      </div>
    );
  }

  if (hasDisplay && displayPresentation === "full") {
    if (displayMode === "side_panel" && displayPanel.available) {
      return (
        <SidePanelToolCall
          actionLabel={actionLabel}
          detailSections={detailSections}
          display={display}
          displayNode={panelDisplayNode}
          state={state}
          statusLabel={statusLabel}
          artifacts={surfacedArtifacts}
          toolCallId={toolCallId}
          toolTitle={toolDisplay.title}
          subject={subject}
          toolName={toolName}
          result={result}
        />
      );
    }

    return (
      <DisplayToolCall
        actionLabel={actionLabel}
        detailSections={detailSections}
        displayNode={renderedDisplay ?? builtInDisplay}
        state={state}
        statusLabel={statusLabel}
        artifacts={artifacts}
        surfacedArtifacts={surfacedArtifacts}
        toolTitle={toolDisplay.title}
        subject={subject}
        toolName={toolName}
        result={result}
      />
    );
  }

  // A picture the agent took of the preview stands small on its row and opens in the file
  // viewer; a refusal says why in the person's words (PREVIEW-SEE-2).
  const capture = readPreviewCapture({ toolName, result, isError });
  if (capture) {
    return (
      <CompactToolCall
        actionLabel={actionLabel}
        detailSections={detailSections}
        outcome={<PreviewCaptureOutcomeView outcome={capture} />}
        state={state}
        statusLabel={statusLabel}
        summary={undefined}
        surfacedArtifacts={[]}
        toolTitle={toolDisplay.title}
        subject={subject}
        toolName={toolName}
        result={result}
      />
    );
  }

  const hasDisclosureContent =
    Boolean(summary) || surfacedArtifacts.length > 0 || detailSections.length > 0;

  if (!hasDisclosureContent) {
    return (
      <div
        className={cn(
          "chat-tool-part my-1 flex max-w-3xl items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-2 text-xs text-muted-foreground",
          state === "failed" && "border-destructive/40 bg-destructive/5 text-destructive"
        )}
        data-testid="tool-call-card"
      >
        <ToolCallHead
          state={state}
          toolName={toolName}
          result={result}
          toolTitle={toolDisplay.title}
          actionLabel={actionLabel}
          statusLabel={statusLabel}
          subject={subject}
        />
      </div>
    );
  }

  return (
    <CompactToolCall
      actionLabel={actionLabel}
      detailSections={detailSections}
      state={state}
      statusLabel={statusLabel}
      summary={summary}
      surfacedArtifacts={surfacedArtifacts}
      toolTitle={toolDisplay.title}
      subject={subject}
      toolName={toolName}
      result={result}
    />
  );
}

/** The App or the preview a folded card's line names. */
function foldedCardName(
  call: { toolName: string; args: unknown; result: unknown; isError?: boolean | undefined },
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  const saved = appSavedByCall({
    toolName: call.toolName,
    result: call.result,
    ...(call.isError === undefined ? {} : { isError: call.isError })
  });
  if (saved) return saved.title;
  const save = readPageSave({ args: call.args, result: call.result });
  return save.state === "built" ? builtPageName(save, t) : undefined;
}

export function DataPart({
  autoPreviewSurfaces = false,
  displayPresentation = "full",
  name,
  data
}: DataPartProps) {
  const { locale, t } = useTranslation();
  const displayPanel = useToolDisplayPanel();
  const displayWidget = useToolDisplayWidget();
  const promotedArtifacts = readWorkspacePromotedArtifactsData(data);
  if (promotedArtifacts) {
    return (
      <div className="chat-tool-part my-3 max-w-3xl">
        <ToolArtifactList
          artifacts={promotedArtifacts.artifacts}
          variant="deliverable"
          autoPreview={autoPreviewSurfaces}
        />
      </div>
    );
  }
  const promotedSurfaces = readWorkspacePromotedSurfacesData(data);
  if (promotedSurfaces) {
    return (
      // Surfaces shown elsewhere render nothing here; an empty wrapper would
      // still add its margin below the message.
      // An inline view has no frame of its own, so it keeps the distance to the text before
      // it that the text after a block keeps (styles.css).
      <div className="chat-tool-part my-6 max-w-5xl has-[>div:empty]:hidden">
        <ToolSurfaceList autoPreview={autoPreviewSurfaces} surfaces={promotedSurfaces.surfaces} />
      </div>
    );
  }
  const renderedDisplay =
    isToolDisplayPayload(data) && displayWidget
      ? displayWidget({
          display: data,
          locale,
          source: "message-metadata"
        })
      : undefined;
  const builtInDisplay =
    isToolDisplayPayload(data) && !hasRenderedNode(renderedDisplay)
      ? renderBuiltInDisplay(data)
      : undefined;
  const panelDisplayNode = isToolDisplayPayload(data) ? (
    <ToolDisplayWidgetNode
      display={data}
      fallback={builtInDisplay}
      locale={locale}
      source="message-metadata"
    />
  ) : (
    builtInDisplay
  );
  const hasDisplay = hasRenderedNode(renderedDisplay) || hasRenderedNode(builtInDisplay);
  const displayMode = isToolDisplayPayload(data) ? readDisplayMode(data) : "inline";
  const details = formatDetails(data);

  if (hasDisplay && displayPresentation === "full") {
    if (displayMode === "side_panel" && displayPanel.available && isToolDisplayPayload(data)) {
      return (
        <SidePanelDataPart
          autoPreview={autoPreviewSurfaces}
          display={data}
          displayNode={panelDisplayNode}
          name={name}
        />
      );
    }

    return <DisplayDataPart displayNode={renderedDisplay ?? builtInDisplay} name={name} />;
  }

  return (
    <div className="chat-tool-part my-2 max-w-3xl rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Wrench size={14} aria-hidden="true" />
        <span>{t("structuredOutput", { name })}</span>
      </div>
      {details ? (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
          {details}
        </pre>
      ) : null}
    </div>
  );
}
