import type { DomainUiWidgetRegistry } from "@vivd-catalyst/chat-ui/shell";
import { weatherForecastWidget } from "./weather-forecast-widget";

export const demoDomainUiWidgets = {
  "weather.forecast": weatherForecastWidget
} satisfies DomainUiWidgetRegistry;
