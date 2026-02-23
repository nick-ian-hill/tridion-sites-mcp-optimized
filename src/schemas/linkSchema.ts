import { z } from "zod";

export const linkSchema = z.object({
    "type": z.literal("Link"),
    IdRef: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/, "IdRef must be a valid TCM URI (e.g., 'tcm:5-123-1024').")
}).describe("A CMS Link object referencing another item by its TCM URI (e.g., 'tcm:5-123-1024'.");