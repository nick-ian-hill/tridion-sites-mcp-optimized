import { z } from "zod";

/**
 * Represents a CMS ExpandableLink.
 * This is required for specific properties in the API, such as a NestedRegion's RegionSchema.
 */
export const expandableLinkSchema = z.object({
    "type": z.literal("ExpandableLink"),
    IdRef: z.string().regex(/^tcm:\d+-\d+-8$/, "IdRef must be a valid TCM URI (e.g., 'tcm:5-123-8').")
}).describe("A CMS ExpandableLink object. Required for properties like NestedRegion.RegionSchema.");