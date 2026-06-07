import { z } from "zod";
export const healthStatusSchema = z.object({
    status: z.literal("ok"),
    service: z.literal("xyz-api"),
    timestamp: z.string()
});
export const printerStatusSchema = z.enum([
    "idle",
    "printing",
    "paused",
    "maintenance"
]);
