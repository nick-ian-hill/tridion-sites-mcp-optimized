import { z } from "zod";
import { fieldValueSchema } from "./fieldValueSchema.js";
import { linkSchema } from "./linkSchema.js";

export const componentPresentationSchemaForTyping = z.object({
    "type": z.literal("ComponentPresentation"),
    Component: linkSchema,
    ComponentTemplate: linkSchema
});

export type RegionForTyping = {
    "type": "EmbeddedRegion";
    RegionName: string;
    Metadata?: Record<string, any>;
    ComponentPresentations?: z.infer<typeof componentPresentationSchemaForTyping>[];
    Regions?: RegionForTyping[];
};

export const regionSchemaForTyping: z.ZodType<RegionForTyping> = z.lazy(() => z.object({
    "type": z.literal("EmbeddedRegion"),
    RegionName: z.string().nonempty(),
    Metadata: z.record(fieldValueSchema).optional(),
    ComponentPresentations: z.array(componentPresentationSchemaForTyping).optional(),
    Regions: z.array(regionSchemaForTyping).optional(),
}));
