import { createContext, useContext, useEffect } from "react";
import type { ConversationSubjectState } from "../conversation/use-conversation-subject";

/** Takes what the conversation in the dock is about, for the dock's head. */
export const DockSubjectContext = createContext<
  ((subject: ConversationSubjectState | undefined) => void) | undefined
>(undefined);

/**
 * Tells the dock's head what the conversation in the dock is about, as the conversation itself
 * knows it while its run goes: the stored subject, or the asset the agent opened since.
 */
export function useReportDockSubject(subject: ConversationSubjectState | undefined): void {
  const report = useContext(DockSubjectContext);
  const kind = subject?.subject.kind;
  const name = subject?.subject.name;
  const title = subject?.title;
  useEffect(() => {
    report?.(
      kind === undefined || name === undefined || title === undefined
        ? undefined
        : { subject: { kind, name }, title }
    );
  }, [report, kind, name, title]);
  useEffect(() => () => report?.(undefined), [report]);
}

/** Takes whether the conversation in the dock is running, for what the page beside it offers. */
export const DockRunContext = createContext<((running: boolean) => void) | undefined>(undefined);

/** Tells the dock whether its conversation's agent is at work now. */
export function useReportDockRun(running: boolean): void {
  const report = useContext(DockRunContext);
  useEffect(() => {
    report?.(running);
  }, [report, running]);
  useEffect(() => () => report?.(false), [report]);
}

/** The asset the agent in the dock is working on while its run goes. */
export interface DockAgentWork {
  kind: string;
  name: string;
}

/** What the agent in the dock works on now, for the pages beside the dock. */
export const DockAgentWorkContext = createContext<DockAgentWork | undefined>(undefined);

/**
 * Whether the agent in the dock is at work on this asset now: a page holds back what would
 * act on a draft the agent is still writing, such as its publish.
 */
export function useDockAgentWorksOn(kind: string, name: string): boolean {
  const work = useContext(DockAgentWorkContext);
  return work?.kind === kind && work.name === name;
}
