import { toolDisplayWidgetRegistry, type ToolDisplayWidget } from "@vivd-catalyst/chat-ui/shell";
import { weatherForecastWidget } from "./weather-forecast-widget";

// The workflow summary keeps the platform's built-in document display.
const workflowSummaryWidget = Object.assign<
  ToolDisplayWidget,
  { kind: string; toolNames: string[] }
>(() => undefined, { kind: "document.analysis", toolNames: ["demo.workflow_summary"] });

export const demoDisplayWidgets = toolDisplayWidgetRegistry(
  weatherForecastWidget,
  workflowSummaryWidget
);
