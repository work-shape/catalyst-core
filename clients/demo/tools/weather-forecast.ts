import { z } from "zod";
import { defineConfiguredTool, defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  weatherForecastOutputSchema,
  type WeatherForecastOutput
} from "./weather-forecast-schema";

const toolConfigSchema = z
  .object({
    permissionRef: z.string().min(1).default("demo-tools"),
    defaultDays: z.number().int().min(1).max(10).default(3),
    maxDays: z.number().int().min(1).max(10).default(5)
  })
  .refine((config) => config.defaultDays <= config.maxDays, {
    message: "defaultDays must be less than or equal to maxDays",
    path: ["defaultDays"]
  });

type WeatherForecastInput = {
  location: string;
  days: number;
  unit: "celsius" | "fahrenheit";
  startDate?: string;
};

export const weatherForecastToolFactory = defineConfiguredTool({
  name: "demo.weather_forecast",
  configSchema: toolConfigSchema,
  create(config) {
    const inputSchema = createInputSchema(config);
    return defineTool({
      name: "demo.weather_forecast",
      description:
        "Return a deterministic sample weather forecast for demo scheduling and travel-planning conversations.",
      inputSchema,
      outputSchema: weatherForecastOutputSchema,
      permission: {
        mode: "allow",
        requiredPermissionRefs: [config.permissionRef]
      },
      async execute(input, context) {
        const locale = context.locale === "de" ? "de" : "en";
        const forecast = createForecast(input, locale);

        return toolSuccess(forecast, {
          display: {
            kind: "weather.forecast",
            version: 1,
            mode: "inline",
            data: forecast
          },
          auditSummary: {
            action: "demo.weather_forecast",
            subject: forecast.location,
            metadata: {
              days: forecast.days.length,
              unit: forecast.unit
            }
          }
        });
      }
    });
  }
});

export const weatherForecastTool = weatherForecastToolFactory.create(toolConfigSchema.parse({}));

function createInputSchema(config: z.infer<typeof toolConfigSchema>) {
  return z.object({
    location: z.string().min(1).max(120).describe("City, region, or place name for the forecast."),
    days: z
      .number()
      .int()
      .min(1)
      .max(config.maxDays)
      .default(config.defaultDays)
      .describe("Number of forecast days to return."),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .describe("Optional ISO date for deterministic demos.")
      .optional()
  });
}

type WeatherLocale = "de" | "en";

function createForecast(
  input: WeatherForecastInput,
  locale: WeatherLocale
): WeatherForecastOutput {
  const seed = hashLocation(input.location);
  const startDate = parseStartDate(input.startDate);
  const unit = input.unit;
  const celsiusDays = Array.from({ length: input.days }, (_, index) => {
    const condition = forecastConditions[(seed + index) % forecastConditions.length] ?? "partly_cloudy";
    const lowCelsius = 8 + ((seed + index * 3) % 9);
    const highCelsius = lowCelsius + 5 + ((seed + index) % 5);
    const precipitationChance = precipitationFor(condition, seed + index);
    const windKph = 8 + ((seed + index * 7) % 22);
    const date = addDays(startDate, index).toISOString().slice(0, 10);
    return {
      date,
      condition,
      high: highCelsius,
      low: lowCelsius,
      precipitationChance,
      windKph,
      summary: createDaySummary(condition, precipitationChance, windKph, locale)
    };
  });

  const days =
    unit === "fahrenheit"
      ? celsiusDays.map((day) => ({
          ...day,
          high: celsiusToFahrenheit(day.high),
          low: celsiusToFahrenheit(day.low)
        }))
      : celsiusDays;

  return {
    location: input.location.trim(),
    generatedAt: new Date().toISOString(),
    unit,
    days,
    advisory: createAdvisory(days, locale)
  };
}

const forecastConditions = ["sunny", "partly_cloudy", "cloudy", "rain", "wind"] as const;

function parseStartDate(startDate: string | undefined): Date {
  if (startDate) {
    return new Date(`${startDate}T00:00:00.000Z`);
  }
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function hashLocation(location: string): number {
  return [...location.trim().toLowerCase()].reduce(
    (hash, char) => (hash * 31 + char.codePointAt(0)!) % 997,
    17
  );
}

function precipitationFor(
  condition: (typeof forecastConditions)[number],
  seed: number
): number {
  if (condition === "rain") {
    return 60 + (seed % 30);
  }
  if (condition === "cloudy") {
    return 25 + (seed % 25);
  }
  if (condition === "partly_cloudy") {
    return 15 + (seed % 20);
  }
  return seed % 20;
}

function createDaySummary(
  condition: (typeof forecastConditions)[number],
  precipitationChance: number,
  windKph: number,
  locale: WeatherLocale
): string {
  const conditionText = describeCondition(condition, locale);
  if (precipitationChance >= 60) {
    return locale === "de"
      ? `${conditionText} mit hoher Regenwahrscheinlichkeit.`
      : `${conditionText} with a high chance of rain.`;
  }
  if (windKph >= 24) {
    return locale === "de" ? `${conditionText} und windig.` : `${conditionText} and breezy.`;
  }
  return locale === "de"
    ? `${conditionText} mit gut planbaren Bedingungen.`
    : `${conditionText} with manageable conditions.`;
}

function createAdvisory(days: WeatherForecastOutput["days"], locale: WeatherLocale): string {
  if (days.some((day) => day.precipitationChance >= 60)) {
    return locale === "de"
      ? "Regenschutz einplanen und Outdoor-Termine flexibel halten."
      : "Carry rain protection and keep outdoor plans flexible.";
  }
  if (days.some((day) => day.windKph >= 24)) {
    return locale === "de"
      ? "Windige Phasen erwarten und leichte Materialien im Freien sichern."
      : "Expect breezy windows; secure lightweight outdoor materials.";
  }
  return locale === "de"
    ? "Die Bedingungen wirken stabil für normale Planung."
    : "Conditions look stable for normal planning.";
}

function describeCondition(condition: (typeof forecastConditions)[number], locale: WeatherLocale): string {
  if (locale === "de") {
    return (
      {
        sunny: "Sonnig",
        partly_cloudy: "Teilweise bewölkt",
        cloudy: "Bewölkt",
        rain: "Regen",
        wind: "Wind"
      } satisfies Record<(typeof forecastConditions)[number], string>
    )[condition];
  }

  return (
    {
      sunny: "Sunny",
      partly_cloudy: "Partly cloudy",
      cloudy: "Cloudy",
      rain: "Rain",
      wind: "Wind"
    } satisfies Record<(typeof forecastConditions)[number], string>
  )[condition];
}

function celsiusToFahrenheit(value: number): number {
  return Math.round((value * 9) / 5 + 32);
}

function formatTemperature(value: number, unit: WeatherForecastOutput["unit"]): string {
  return `${value} ${unit === "celsius" ? "C" : "F"}`;
}
