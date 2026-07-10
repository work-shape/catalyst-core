import { z } from "zod";

export const forecastDaySchema = z.object({
  date: z.string(),
  condition: z.enum(["sunny", "partly_cloudy", "cloudy", "rain", "wind"]),
  high: z.number(),
  low: z.number(),
  precipitationChance: z.number().int().min(0).max(100),
  windKph: z.number().int().nonnegative(),
  summary: z.string()
});

export const weatherForecastOutputSchema = z.object({
  location: z.string(),
  generatedAt: z.string(),
  unit: z.enum(["celsius", "fahrenheit"]),
  days: z.array(forecastDaySchema),
  advisory: z.string()
});

export type WeatherForecastDay = z.infer<typeof forecastDaySchema>;
export type WeatherForecastOutput = z.infer<typeof weatherForecastOutputSchema>;
