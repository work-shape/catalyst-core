import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { weatherForecastToolFactory } from "./weather-forecast";
import { workflowSummaryToolFactory } from "./workflow-summary";

export const demoTools = [
  workflowSummaryToolFactory,
  weatherForecastToolFactory
] satisfies ToolAssemblyDefinition[];
