import { z } from "zod";

export const WeatherConditionSchema = z.enum([
  "clear",
  "cloudy",
  "fog",
  "rain",
  "snow",
  "storm",
  "unknown",
]);
export type WeatherCondition = z.infer<typeof WeatherConditionSchema>;

export const EnvironmentTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "A valid IANA timezone is required." },
  );

export const WeatherLocationSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(240),
    name: z.string().trim().min(1).max(120).optional(),
    /** Administrative area names supplied by the geocoder; not a street address. */
    address: z.string().trim().min(1).max(240).optional(),
    country: z.string().trim().min(1).max(120).optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    timezone: EnvironmentTimezoneSchema,
  })
  .strict();
export type WeatherLocation = z.infer<typeof WeatherLocationSchema>;

export const WeatherSnapshotSchema = z
  .object({
    condition: WeatherConditionSchema,
    precipitation: z.number().finite().min(0).max(1000),
    cloudCover: z.number().finite().min(0).max(100),
    observedAt: z.string().datetime({ offset: true }),
    fetchedAt: z.string().datetime({ offset: true }),
    isDay: z.boolean(),
    timezone: EnvironmentTimezoneSchema,
    solar: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            sunrise: z.string().datetime({ offset: true }).nullable(),
            sunset: z.string().datetime({ offset: true }).nullable(),
          })
          .strict(),
      )
      .max(7),
  })
  .strict();
export type WeatherSnapshot = z.infer<typeof WeatherSnapshotSchema>;

export const EnvironmentWeatherResponseSchema = z
  .object({
    status: z.enum(["fresh", "stale", "unavailable"]),
    weather: WeatherSnapshotSchema.nullable(),
    retryAfterSeconds: z.number().int().min(1).max(3600).optional(),
    attribution: z
      .object({
        name: z.string().min(1).max(100),
        url: z.string().url(),
        licenseUrl: z.string().url(),
      })
      .strict(),
  })
  .strict();
export type EnvironmentWeatherResponse = z.infer<
  typeof EnvironmentWeatherResponseSchema
>;

export const EnvironmentLocationsResponseSchema = z
  .object({
    items: z.array(WeatherLocationSchema).max(5),
  })
  .strict();
export type EnvironmentLocationsResponse = z.infer<
  typeof EnvironmentLocationsResponseSchema
>;
