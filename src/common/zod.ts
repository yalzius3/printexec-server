import { BadRequestException } from "@nestjs/common";
import type { ZodSchema } from "zod";

export function parseWithSchema<T>(schema: ZodSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new BadRequestException(result.error.flatten());
  }

  return result.data;
}
