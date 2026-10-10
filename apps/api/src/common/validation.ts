import type { z } from "zod";
import { ValidationError } from "./errors";

/** Parses a request body, turning schema failures into a 422 with the issues. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, message: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(message, { issues: parsed.error.issues });
  return parsed.data;
}
