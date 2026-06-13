import { defineClientInstance } from "@vivd-catalyst/client-assembly";
import { weatherForecastToolFactory } from "../tools/weather-forecast";
import { workflowSummaryToolFactory } from "../tools/workflow-summary";

export default defineClientInstance({
  rootDir: new URL("..", import.meta.url),
  tools: [workflowSummaryToolFactory, weatherForecastToolFactory]
});
