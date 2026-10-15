import { toolDisplayWidgetRegistry } from "@work-shape/catalyst-chat-ui/shell";
import { weatherForecastWidget } from "./weather-forecast-widget";

export const demoDisplayWidgets = toolDisplayWidgetRegistry(weatherForecastWidget);
