import { z } from "zod";
import { IntegrationIdSchema } from "./integrations.js";

export const MediaSourcePreferencesSchema = z
  .object({
    providerOrder: z
      .array(IntegrationIdSchema)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Source IDs must be unique",
      ),
  })
  .strict();
export type MediaSourcePreferences = z.infer<
  typeof MediaSourcePreferencesSchema
>;

/** New sources append predictably; local storage leads until a viewer changes the order. */
export function resolveMediaSourceOrder(
  saved: readonly string[],
  known: readonly string[],
): string[] {
  return [...new Set([...saved, "local-files", ...known])].filter((id) =>
    known.includes(id),
  );
}

export function orderMediaSources<T extends { providerId: string }>(
  sources: readonly T[],
  order: readonly string[],
): T[] {
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index < 0 ? order.length : index;
  };
  return [...sources].sort((a, b) => rank(a.providerId) - rank(b.providerId));
}
