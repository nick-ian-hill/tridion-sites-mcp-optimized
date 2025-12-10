import { z } from "zod";
import { fieldValueSchema } from "./fieldValueSchema.js";
import { linkSchema } from "./linkSchema.js";

export const componentPresentationSchemaForTyping = z.object({
    "type": z.literal("ComponentPresentation"),
    Component: linkSchema,
    ComponentTemplate: linkSchema.optional()
});

export type RegionForTyping = {
    "type": "EmbeddedRegion";
    RegionName: string;
    Metadata?: Record<string, any>;
    ComponentPresentations?: z.infer<typeof componentPresentationSchemaForTyping>[];
    Regions?: RegionForTyping[];
};

export const regionSchemaForTyping = z.object({
    "type": z.literal("EmbeddedRegion"),
    RegionName: z.string().nonempty(),
    Metadata: z.record(fieldValueSchema).optional(),
    ComponentPresentations: z.array(componentPresentationSchemaForTyping).optional(),
    Regions: z.array(z.record(z.any()))
        .optional()
        .describe("A recursive list of nested regions. Each item must be a valid Region object with the same structure as this parent.")
});
