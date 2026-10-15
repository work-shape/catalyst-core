import type { ReactNode, Ref } from "react";
import { EmptyState, Spinner } from "@work-shape/catalyst-ui";

/** What a preview shows. A bundle is a built Page at an address of the instance. */
type PreviewSource = { kind: "bundle"; url: string };

/**
 * `ready`: the source is shown. `starting`: it is on its way. `stopped`: it is no longer there
 * for this viewer. `failed`: it could not be loaded.
 */
export type PreviewState = "ready" | "starting" | "stopped" | "failed";

export interface PreviewPaneProps {
  /** Absent while there is nothing to show yet, or no longer. */
  source: PreviewSource | undefined;
  state: PreviewState;
  /** The sentence of every state but `ready`. */
  message?: string;
  /** Names the frame for someone who does not see it. */
  title: string;
  /** One action under the sentence of a state that is not `ready`, such as trying again. */
  action?: ReactNode;
  frameRef?: Ref<HTMLIFrameElement>;
}

/**
 * The frame a Page is shown in, and what stands in its place while there is none. The frame
 * allows scripts and nothing else: no origin, no form, no popup, no navigation of the window
 * around it. The document it loads says the same about itself in its own headers.
 */
export function PreviewPane({ source, state, message, title, action, frameRef }: PreviewPaneProps) {
  if (state === "ready" && source) {
    return (
      <iframe
        // Another address is another document: the frame starts over instead of navigating.
        key={source.url}
        ref={frameRef}
        title={title}
        src={source.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        data-testid="page-preview-frame"
        className="block size-full border-0 bg-background"
      />
    );
  }
  return (
    <div
      role={state === "starting" ? "status" : undefined}
      data-preview-state={state}
      className="flex size-full items-center justify-center overflow-y-auto"
    >
      <EmptyState
        icon={state === "starting" ? <Spinner size="lg" /> : undefined}
        action={state === "starting" ? undefined : action}
      >
        {message}
      </EmptyState>
    </div>
  );
}
