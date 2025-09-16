import { z } from "zod";
import { toLink } from "./links.js";
import { convertItemIdToContextPublication } from "./convertItemIdToContextPublication.js";
import { reorderFieldsBySchema } from "./fieldReordering.js";
import { componentPresentationSchemaForTyping, RegionForTyping } from "../schemas/pageSchemas.js";
import { AxiosInstance } from "axios";

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
    parentSchemaId: string,
    axiosInstance: AxiosInstance
): Promise<any[]> {
    if (!regions) return [];

    const processSingleRegion = async (regionData: RegionForTyping): Promise<any> => {
        const name = regionData.RegionName;
        let processedMetadata = regionData.Metadata;
        let regionSchemaIdRef: string | undefined;

        try {
            const parentSchemaResponse = await axiosInstance.get(`/items/${parentSchemaId.replace(':', '_')}`);
            const parentSchema = parentSchemaResponse.data;
            const regionSchemaContainer = parentSchema.RegionSchema
                ? (await axiosInstance.get(`/items/${parentSchema.RegionSchema.IdRef.replace(':', '_')}`)).data
                : parentSchema;
            const regionDef = regionSchemaContainer.Regions?.find((r: any) => r.SchemaName === name);
            if (regionDef?.RegionSchema?.IdRef) {
                regionSchemaIdRef = regionDef.RegionSchema.IdRef;
            }
        } catch (e) {
            console.warn(`Could not fetch schema info from parent ${parentSchemaId} to process Region '${name}'.`);
        }

        if (regionSchemaIdRef && processedMetadata) {
            processedMetadata = await reorderFieldsBySchema(processedMetadata, regionSchemaIdRef, 'content', axiosInstance);
        }

        let nestedRegions: any[] = [];
        if (regionSchemaIdRef && regionData.Regions) {
            nestedRegions = await processRegions(regionData.Regions, contextId, regionSchemaIdRef, axiosInstance);
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