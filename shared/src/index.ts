import { z } from "zod";

export const healthStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("xyz-api"),
  timestamp: z.string()
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const printerStatusSchema = z.enum([
  "idle",
  "printing",
  "paused",
  "maintenance"
]);

export type PrinterStatus = z.infer<typeof printerStatusSchema>;
