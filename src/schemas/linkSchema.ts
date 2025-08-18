import { z } from "zod";

export const linkSchema = z.object({
    "$type": z.literal("Link"),
    IdRef: z.string().regex(/^tcm:\d+-\d+-\d+$/, "Invalid TCM URI format for IdRef.")
}).describe("A link to another CMS item.");