import { toolDisplayWidgetRegistry } from "@vivd-catalyst/chat-ui/shell";
import { weatherForecastWidget } from "./weather-forecast-widget";

export const demoDisplayWidgets = toolDisplayWidgetRegistry(weatherForecastWidget);
