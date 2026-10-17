import { useState, type ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { Avatar, PageHeaderShellAction, SplitHandle } from "@work-shape/catalyst-ui";
import { conversationTitle } from "../../shared/conversation-title";
import { useTranslation } from "../../shared/i18n";
import type { ConversationSubjectState } from "../conversation/use-conversation-subject";
import { SurfaceSlot } from "../surface/surface-slot";
import type { WorkspaceDock } from "../workspace/use-workspace-dock";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { ChatColumn, DockHead, DockPage, DockPageAction, type ChatColumnMode } from "./chat-dock";
import { DockSubjectContext } from "./dock-subject";
import { useDockArrival, useDockWidth } from "./use-dock-layout";

/** How the shell lays out the conversation and the page for the dock. */
export interface ChatDockView {
  /** Where the conversation stands; nothing to show on a page without a dock. */
  mode: ChatColumnMode | undefined;
  layout: ReturnType<typeof useDockWidth>;
  arrival: ReturnType<typeof useDockArrival>["arrival"];
  arrived(): void;
  /** Takes the main area the dock and the page share, for its width. */
  measure(element: HTMLElement | null): void;
}

/**
 * The conversation lives in one column: the main area on the chat route, the dock beside every
 * other page while it holds a conversation or is open, unseen while it is closed.
 */
export function useChatDockView({
  dock,
  route,
  onChatRoute,
  viewTransitions
}: {
  dock: WorkspaceDock;
  route: WorkspaceRoute;
  onChatRoute: boolean;
  /** The host plays the dock's movement as a view transition. */
  viewTransitions: boolean;
}): ChatDockView {
  const mode: ChatColumnMode | undefined = onChatRoute
    ? "main"
    : dock.open
      ? "dock"
      : dock.conversationId !== undefined
        ? "closed"
        : undefined;
  const [content, measure] = useState<HTMLElement | null>(null);
  const layout = useDockWidth(content);
  const { arrival, arrived } = useDockArrival(
    { route, chat: dock.open ? dock.conversationId : undefined },
    viewTransitions
  );
  return { mode, layout, arrival, arrived, measure };
}

/**
 * The conversation's column with the dock's head and the handle that resizes it. A conversation
 * about an asset is named in the head by its agent, with the agent's mark, and "Working on:"
 * the asset, as the conversation reports it.
 */
export function DockedChat({
  view,
  dock,
  title,
  agent,
  onOpenFullChat,
  children
}: {
  view: ChatDockView & { mode: ChatColumnMode };
  dock: WorkspaceDock;
  /** The conversation's title, where it has one. */
  title: string | undefined;
  /** The name people read for the conversation's agent. */
  agent: string | undefined;
  /** Absent while the dock holds no conversation. */
  onOpenFullChat?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { layout } = view;
  const [subject, reportSubject] = useState<ConversationSubjectState>();
  const subjectAgent = subject === undefined ? undefined : agent;
  return (
    <ChatColumn
      mode={view.mode}
      over={layout.over}
      inFront={dock.inFront}
      width={layout.width}
      arrival={view.arrival}
      onArrived={view.arrived}
      head={
        <DockHead
          title={
            subjectAgent ??
            (dock.conversationId === undefined
              ? t("nav.newChat")
              : title
                ? conversationTitle(title, t)
                : t("dock.chat"))
          }
          mark={
            subjectAgent === undefined ? undefined : (
              <Avatar kind="agent" size="sm" name={subjectAgent} />
            )
          }
          subtitle={
            subjectAgent === undefined || subject === undefined
              ? undefined
              : `${t("conversationSubjectWorkingOn")} ${subject.title}`
          }
          subjectKind={subjectAgent === undefined ? undefined : subject?.subject.kind}
          over={layout.over}
          onShowPage={dock.showPage}
          onOpenFullChat={onOpenFullChat}
          onClose={dock.close}
        />
      }
      handle={
        <SplitHandle
          label={t("dock.resize")}
          edge="right"
          width={layout.width}
          min={layout.min}
          max={layout.max}
          onResize={layout.choose}
          onResizeEnd={layout.keep}
        />
      }
    >
      <DockSubjectContext.Provider value={reportSubject}>{children}</DockSubjectContext.Provider>
    </ChatColumn>
  );
}

/**
 * The page beside the dock. Its head brings back a closed dock, or the dock that lies behind
 * the page in a narrow window.
 */
export function DockedPage({
  view,
  dock,
  running,
  children
}: {
  view: ChatDockView;
  dock: WorkspaceDock;
  /** The dock's conversation has an answer running. */
  running: boolean;
  children: ReactNode;
}) {
  const behind = view.mode === "dock" && view.layout.over && !dock.inFront;
  const action =
    view.mode === "closed" ? (
      <DockPageAction kind="reopen" running={running} onClick={dock.reopen} />
    ) : behind ? (
      <DockPageAction kind="show" running={running} onClick={dock.showChat} />
    ) : null;
  return (
    <PageHeaderShellAction action={action}>
      <DockPage
        covered={view.mode === "dock" && view.layout.over && dock.inFront}
        arrival={view.arrival}
        onArrived={view.arrived}
      >
        {children}
        <DockedPageSurface />
      </DockPage>
    </PageHeaderShellAction>
  );
}

/**
 * What the dock's conversation opens to look at, such as a file's preview, covers the page
 * beside the dock and leaves the conversation in view; closing it shows the page as it was.
 */
function DockedPageSurface() {
  const { t } = useTranslation();
  return (
    <SurfaceSlot
      covers
      under={{ label: t("dock.showPage"), icon: <PanelRight aria-hidden="true" /> }}
    />
  );
}
