import { AuiProvider, Tools, defineToolkit, useAui } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { ToolCallPart } from "./tool-call";

const backendToolUi = {
  type: "backend",
  render: ToolCallPart
} as const;

const vivdToolUiToolkit = defineToolkit({
  show_view: backendToolUi,
  read_document: backendToolUi,
  view_document_page: backendToolUi,
  "demo.weather_forecast": backendToolUi,
  "demo.workflow_summary": backendToolUi
});

export function AssistantToolRegistry({ children }: { children: ReactNode }) {
  const aui = useAui({ tools: Tools({ toolkit: vivdToolUiToolkit }) });

  return <AuiProvider value={aui}>{children}</AuiProvider>;
}
