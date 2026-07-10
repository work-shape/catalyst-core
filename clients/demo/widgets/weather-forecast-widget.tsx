import {
  CalendarDays,
  Cloud,
  CloudRain,
  CloudSun,
  MapPin,
  Sun,
  ThermometerSun,
  Wind
} from "lucide-react";
import { defineToolDisplayWidget, type ToolDisplayRenderInput } from "@vivd-catalyst/chat-ui/shell";
import {
  weatherForecastOutputSchema,
  type WeatherForecastDay,
  type WeatherForecastOutput
} from "../tools/weather-forecast-schema";

const translations = {
  en: {
    forecast: "Weather forecast",
    dayForecast: "{count}-day forecast",
    precipitation: "{chance}% precipitation",
    wind: "{speed} km/h wind"
  },
  de: {
    forecast: "Wettervorhersage",
    dayForecast: "{count}-Tage-Prognose",
    precipitation: "{chance}% Niederschlag",
    wind: "{speed} km/h Wind"
  }
} as const;

export const weatherForecastWidget = defineToolDisplayWidget({
  kind: "weather.forecast",
  version: 1,
  dataSchema: weatherForecastOutputSchema,
  render: ({ data, input }) => <WeatherForecastPreview forecast={data} input={input} />
});

function WeatherForecastPreview({
  forecast,
  input
}: {
  forecast: WeatherForecastOutput;
  input: ToolDisplayRenderInput;
}) {
  const locale = input.locale === "de" ? "de" : "en";
  const unitLabel = forecast.unit === "fahrenheit" ? "F" : "C";

  return (
    <div className="px-3 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <MapPin size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{t(locale, "forecast")}</p>
            <p className="truncate text-sm text-muted-foreground">{forecast.location}</p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
          <CalendarDays size={13} aria-hidden="true" />
          {t(locale, "dayForecast", { count: forecast.days.length })}
        </span>
      </div>
      {forecast.advisory ? (
        <p className="mt-3 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">{forecast.advisory}</p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {forecast.days.map((day) => {
          const DayIcon = weatherIconFor(day.condition);
          return (
            <div key={day.date} className="min-w-0 border-l-2 border-primary/30 pl-3">
              <div className="flex items-center gap-2">
                <DayIcon size={16} className="shrink-0 text-primary" aria-hidden="true" />
                <p className="truncate text-sm font-medium">{formatForecastDate(day.date, locale)}</p>
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm">
                <ThermometerSun size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>
                  {day.low}-{day.high} {unitLabel}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <CloudRain size={14} className="shrink-0" aria-hidden="true" />
                <span>{t(locale, "precipitation", { chance: day.precipitationChance })}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Wind size={14} className="shrink-0" aria-hidden="true" />
                <span>{t(locale, "wind", { speed: day.windKph })}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {day.summary}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function weatherIconFor(condition: WeatherForecastDay["condition"]) {
  if (condition === "sunny") {
    return Sun;
  }
  if (condition === "partly_cloudy") {
    return CloudSun;
  }
  if (condition === "rain") {
    return CloudRain;
  }
  if (condition === "wind") {
    return Wind;
  }
  return Cloud;
}

function formatForecastDate(date: string, locale: "de" | "en"): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(parsed);
}

function t(
  locale: "de" | "en",
  key: keyof (typeof translations)["en"],
  values?: Record<string, string | number>
): string {
  const message: string = translations[locale][key] ?? translations.en[key];
  if (!values) {
    return message;
  }
  return Object.entries(values).reduce(
    (currentMessage, [name, value]) => currentMessage.replaceAll(`{${name}}`, String(value)),
    message
  );
}
