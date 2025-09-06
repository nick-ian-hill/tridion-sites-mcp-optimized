import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { fieldValueSchema } from "./fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { linkSchema } from "./linkSchema.js";

// --- Shared Type Definitions and Schemas ---

export const componentPresentationSchemaForTyping = z.object({
    "$type": z.literal("ComponentPresentation"),
    Component: linkSchema,
    ComponentTemplate: linkSchema
});

export type RegionForTyping = {
    "$type": "EmbeddedRegion";
    RegionName: string;
    Metadata?: Record<string, any>;
    ComponentPresentations?: z.infer<typeof componentPresentationSchemaForTyping>[];
    Regions?: RegionForTyping[];
};

export const regionSchemaForTyping: z.ZodType<RegionForTyping> = z.lazy(() => z.object({
    "$type": z.literal("EmbeddedRegion"),
    RegionName: z.string().nonempty(),
    Metadata: z.record(fieldValueSchema).optional(),
    ComponentPresentations: z.array(componentPresentationSchemaForTyping).optional(),
    Regions: z.array(regionSchemaForTyping).optional(),
}));


// --- Shared Helper Functions ---

export function processComponentPresentations(
    cps: z.infer<typeof componentPresentationSchemaForTyping>[] | undefined,
    contextId: string
): any[] {
    if (!cps) return [];
    return cps.map(cp => ({
        ...cp,
        Component: toLink(convertItemIdToContextPublication(cp.Component.IdRef, contextId)),
        ComponentTemplate: toLink(convertItemIdToContextPublication(cp.ComponentTemplate.IdRef, contextId)),
    }));
}

export async function processRegions(
    regions: RegionForTyping[] | undefined,
    contextId: string,
    parentSchemaId: string
): Promise<any[]> {
    if (!regions) return [];

    const processSingleRegion = async (regionData: RegionForTyping): Promise<any> => {
        const name = regionData.RegionName;
        let processedMetadata = regionData.Metadata;
        let regionSchemaIdRef: string | undefined;

        try {
            const parentSchemaResponse = await authenticatedAxios.get(`/items/${parentSchemaId.replace(':', '_')}`);
            const parentSchema = parentSchemaResponse.data;
            const regionSchemaContainer = parentSchema.RegionSchema
                ? (await authenticatedAxios.get(`/items/${parentSchema.RegionSchema.IdRef.replace(':', '_')}`)).data
                : parentSchema;
            const regionDef = regionSchemaContainer.Regions?.find((r: any) => r.SchemaName === name);
            if (regionDef?.RegionSchema?.IdRef) {
                regionSchemaIdRef = regionDef.RegionSchema.IdRef;
            }
        } catch (e) {
            console.warn(`Could not fetch schema info from parent ${parentSchemaId} to process Region '${name}'.`);
        }

        if (regionSchemaIdRef && processedMetadata) {
            processedMetadata = await reorderFieldsBySchema(processedMetadata, regionSchemaIdRef, 'content');
        }

        let nestedRegions: any[] = [];
        if (regionSchemaIdRef && regionData.Regions) {
            nestedRegions = await processRegions(regionData.Regions, contextId, regionSchemaIdRef);
        }

        const regionPayload: any = {
            "$type": "EmbeddedRegion",
            RegionName: name,
            Metadata: processedMetadata,
            ComponentPresentations: processComponentPresentations(regionData.ComponentPresentations, contextId),
            Regions: nestedRegions
        };

        if (regionSchemaIdRef) {
            regionPayload.RegionSchema = toLink(convertItemIdToContextPublication(regionSchemaIdRef, contextId));
        }
        return regionPayload;
    };

    return Promise.all(
        regions.map(regionData => processSingleRegion(regionData))
    );
}
