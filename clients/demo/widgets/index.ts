import type { ToolDisplayWidgetRegistry } from "@vivd-catalyst/chat-ui/shell";
import { weatherForecastWidget } from "./weather-forecast-widget";

export const demoDisplayWidgets = {
  "weather.forecast": weatherForecastWidget
} satisfies ToolDisplayWidgetRegistry;
