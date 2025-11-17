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
    return cps.map(cp => {
        if (!cp.Component || !cp.Component.IdRef) {
            throw new Error(
                "Invalid Component Presentation data: A 'Component' link is missing or malformed."
            );
        }

        const templateId = cp.ComponentTemplate?.IdRef;
        const effectiveTemplateId = templateId ? convertItemIdToContextPublication(templateId, contextId) : "tcm:0-0-0";
        
        return {
            ...cp,
            Component: toLink(convertItemIdToContextPublication(cp.Component.IdRef, contextId)),
            ComponentTemplate: toLink(effectiveTemplateId),
        };
    });
}

export async function processRegions(
    regions: RegionForTyping[] | undefined,
    contextId: string,
    pageTemplateId: string,
    axiosInstance: AxiosInstance
): Promise<any[]> {
    if (!regions) return [];

    // First, get the Page Template to find its Region Schema
    let pageTemplate: any;
    try {
        pageTemplate = (await axiosInstance.get(`/items/${pageTemplateId.replace(':', '_')}`)).data;
    } catch (e) {
        throw new Error(`Failed to load Page Template ${pageTemplateId} to process regions: ${String(e)}`);
    }

    // Get the main Region Schema linked from the Page Template
    let mainRegionSchema: any;
    const regionSchemaId = pageTemplate.PageSchema?.IdRef;
    if (regionSchemaId) {
        try {
            mainRegionSchema = (await axiosInstance.get(`/items/${regionSchemaId.replace(':', '_')}`)).data;
        } catch (e) {
            console.warn(`Could not load main Region Schema ${regionSchemaId} for page ${contextId}.`);
        }
    }

    const processSingleRegion = async (regionData: RegionForTyping): Promise<any> => {
        const name = regionData.RegionName;
        const agentProvidedMetadata = regionData.Metadata;
        let finalMetadataPayload: any = undefined;
        let regionSchemaIdRef: string | undefined;

        if (mainRegionSchema?.RegionDefinition?.NestedRegions) {
            const regionDef = mainRegionSchema.RegionDefinition.NestedRegions.find(
                (r: any) => r.RegionName === name
            );
            if (regionDef?.RegionSchema?.IdRef) {
                regionSchemaIdRef = regionDef.RegionSchema.IdRef;
            }
        }

        if (regionSchemaIdRef) {
            if (agentProvidedMetadata) {
                finalMetadataPayload = await reorderFieldsBySchema(agentProvidedMetadata, regionSchemaIdRef, 'content', axiosInstance);
            } else {
                finalMetadataPayload = { "$type": "FieldsValueDictionary" };
            }
        } else if (agentProvidedMetadata) {
            throw new Error(`Metadata provided for Region '${name}', but that Region has no RegionSchema defined on the Page Template.`);
        }
        
        let nestedRegions: any[] = [];
        if (regionSchemaIdRef && regionData.Regions) {
            nestedRegions = await processRegions(regionData.Regions, contextId, regionSchemaIdRef, axiosInstance);
        }

        const regionPayload: any = {
            "$type": "EmbeddedRegion",
            RegionName: name,
            Metadata: finalMetadataPayload,
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