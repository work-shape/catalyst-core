import { AuiProvider, Tools, defineToolkit, useAui } from "@assistant-ui/react";
import { useMemo, type ReactNode } from "react";
import { useToolDisplayToolNames } from "../domain-ui-widgets";
import { ToolCallPart } from "../tool-call";

const backendToolUi = {
  type: "backend",
  render: ToolCallPart
} as const;

export function AssistantToolRegistry({ children }: { children: ReactNode }) {
  const toolNames = useToolDisplayToolNames();
  const toolkit = useMemo(
    () =>
      defineToolkit({
        show_view: backendToolUi,
        ...Object.fromEntries(toolNames.map((name) => [name, backendToolUi]))
      }),
    [toolNames]
  );
  const aui = useAui({ tools: Tools({ toolkit }) });

  return <AuiProvider value={aui}>{children}</AuiProvider>;
}
