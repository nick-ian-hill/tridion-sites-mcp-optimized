import { z } from "zod";
import { linkSchema } from "./linkSchema.js";
import { expandableLinkSchema } from "./expandableLinkSchema.js";

export const occurrenceConstraintSchema = z.object({
    "$type": z.literal("OccurrenceConstraint"),
    MaxOccurs: z.number().int().describe("Maximum number of Component Presentations allowed in this Region."),
    MinOccurs: z.number().int().describe("Minimum number of Component Presentations allowed in this Region.")
});

export const typeConstraintSchema = z.object({
    "$type": z.literal("TypeConstraint"),
    BasedOnSchema: linkSchema.optional().describe("A Link to a Schema. Only Components based on this Schema are allowed."),
    BasedOnComponentTemplate: linkSchema.optional().describe("A Link to a Component Template. Only CPs with this template are allowed.")
});

export const componentPresentationConstraintSchema = z.union([
    occurrenceConstraintSchema,
    typeConstraintSchema
]);

export const nestedRegionSchema: z.ZodTypeAny = z.lazy(() => z.object({
    "$type": z.literal("NestedRegion"),
    RegionName: z.string().describe("The machine name of the nested Region."),
    IsMandatory: z.boolean().optional().describe("Whether this nested Region is mandatory."),
    RegionSchema: expandableLinkSchema.describe("A Link to another Region Schema that defines this nested Region. Must be an ExpandableLink."),
    Regions: z.array(nestedRegionSchema).optional().describe("Deeper nested regions, if the schema supports it.")
}));

export const regionDefinitionSchema = z.object({
    "$type": z.literal("RegionDefinition"),
    ComponentPresentationConstraints: z.array(componentPresentationConstraintSchema).optional()
        .describe("An array of constraints (OccurrenceConstraint, TypeConstraint) for Component Presentations in this Region."),
    NestedRegions: z.array(nestedRegionSchema).optional()
        .describe("An array of nested Region definitions.")
}).describe("A JSON object defining the Region's constraints and nested regions.");