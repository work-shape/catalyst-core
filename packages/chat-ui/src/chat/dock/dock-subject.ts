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
