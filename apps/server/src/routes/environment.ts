import type { FastifyInstance } from "fastify";
import {
  EnvironmentLocationsUnavailableError,
  type EnvironmentWeatherService,
} from "../services/environment-weather.js";

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  service: EnvironmentWeatherService,
): void {
  app.get(
    "/api/v1/environment/locations",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 2, maxLength: 100 },
            language: { type: "string", pattern: "^[a-z]{2}$", default: "en" },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { q: string; language: string };
      reply.header("Cache-Control", "private, no-store");
      try {
        return { items: await service.locations(query.q, query.language) };
      } catch (error) {
        if (!(error instanceof EnvironmentLocationsUnavailableError))
          throw error;
        return reply
          .code(503)
          .header("Retry-After", error.retryAfterSeconds)
          .send({
            error: {
              code: "ENVIRONMENT_LOCATIONS_UNAVAILABLE",
              message:
                "City search is temporarily unavailable. Try again later.",
            },
          });
      }
    },
  );
  app.get(
    "/api/v1/environment/weather",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["latitude", "longitude"],
          properties: {
            latitude: { type: "number", minimum: -90, maximum: 90 },
            longitude: { type: "number", minimum: -180, maximum: 180 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { latitude: number; longitude: number };
      const result = await service.weather(query.latitude, query.longitude);
      reply.header("Cache-Control", "private, no-store");
      if (result.retryAfterSeconds)
        reply.header("Retry-After", result.retryAfterSeconds);
      return result;
    },
  );
}
