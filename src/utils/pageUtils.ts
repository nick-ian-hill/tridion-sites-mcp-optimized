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

/**
 * Processes regions by comparing the user-provided regions against the Schema definition.
 * It automatically fills in missing regions defined in the schema with empty objects.
 * @param regions The array of regions provided by the user/agent.
 * @param contextId The Publication context ID (e.g., tcm:0-5-1).
 * @param containerId The ID of the container definition (either a Page Template ID or a Region Schema ID).
 * @param axiosInstance Authenticated Axios instance.
 */
export async function processRegions(
    regions: RegionForTyping[] | undefined,
    contextId: string,
    containerId: string,
    axiosInstance: AxiosInstance
): Promise<any[]> {
    
    // 1. Fetch the Container Item (Page Template or Region Schema)
    // We need this to find the "RegionDefinition" which tells us what regions are expected.
    let containerItem: any;
    try {
        containerItem = (await axiosInstance.get(`/items/${containerId.replace(':', '_')}`)).data;
    } catch (e) {
        console.warn(`Failed to load container item ${containerId} for region processing: ${String(e)}. Auto-fill of missing regions will be disabled.`);
        // Fallback: If we can't load the schema, we just process what the user gave us without auto-fill.
        if (!regions) return [];
        return Promise.all(regions.map(r => processSingleRegion(r, undefined, contextId, axiosInstance)));
    }

    // 2. Determine the "Region Schema" that defines the structure
    let definitionSchema: any;

    if (containerItem.$type === 'PageTemplate') {
        // If it's a Page Template, look for the linked PageSchema
        const pageSchemaId = containerItem.PageSchema?.IdRef;
        if (pageSchemaId) {
            try {
                definitionSchema = (await axiosInstance.get(`/items/${pageSchemaId.replace(':', '_')}`)).data;
            } catch (e) {
                console.warn(`Could not load Page Schema ${pageSchemaId} linked from Page Template ${containerId}.`);
            }
        }
    } else if (containerItem.$type === 'Schema' && containerItem.Purpose === 'Region') {
        // If we passed a Schema ID (recursion), this item IS the definition
        definitionSchema = containerItem;
    }

    // 3. Merge User Regions with Schema Definitions
    const definedNestedRegions = definitionSchema?.RegionDefinition?.NestedRegions || [];
    const userRegions = regions || [];
    const processedRegions: any[] = [];
    
    // Keep track of which user regions we have consumed to identify ad-hoc ones later
    const consumedUserRegionNames = new Set<string>();

    // A. Iterate through DEFINED regions (Auto-fill logic)
    for (const def of definedNestedRegions) {
        const regionName = def.RegionName;
        const userRegion = userRegions.find(r => r.RegionName === regionName);

        if (userRegion) {
            // User provided this region
            consumedUserRegionNames.add(regionName);
            processedRegions.push(await processSingleRegion(userRegion, definitionSchema, contextId, axiosInstance));
        } else {
            // User missed this region -> Auto-fill empty object
            // Note: We purposefully pass empty ComponentPresentations and Regions to trigger recursion
            // inside processSingleRegion, ensuring deep mandatory structures are also filled.
            const emptyRegionData: RegionForTyping = {
                type: "EmbeddedRegion",
                RegionName: regionName,
                ComponentPresentations: [],
                Regions: []
            };
            processedRegions.push(await processSingleRegion(emptyRegionData, definitionSchema, contextId, axiosInstance));
        }
    }

    // B. Process Ad-Hoc Regions (User provided, but not in schema)
    // Some implementations allow loose regions not strictly defined in the schema.
    for (const userRegion of userRegions) {
        if (!consumedUserRegionNames.has(userRegion.RegionName)) {
             processedRegions.push(await processSingleRegion(userRegion, definitionSchema, contextId, axiosInstance));
        }
    }

    return processedRegions;
}

/**
 * Helper to process a single region object.
 */
async function processSingleRegion(
    regionData: RegionForTyping,
    parentRegionSchema: any,
    contextId: string,
    axiosInstance: AxiosInstance
): Promise<any> {
    const name = regionData.RegionName;
    const agentProvidedMetadata = regionData.Metadata;
    
    let finalMetadataPayload: any = undefined;
    let regionSchemaIdRef: string | undefined;

    // 1. Find this region's definition in the parent schema to get its Schema ID
    if (parentRegionSchema?.RegionDefinition?.NestedRegions) {
        const regionDef = parentRegionSchema.RegionDefinition.NestedRegions.find(
            (r: any) => r.RegionName === name
        );
        if (regionDef?.RegionSchema?.IdRef) {
            regionSchemaIdRef = regionDef.RegionSchema.IdRef;
        }
    }

    // 2. Process Metadata
    if (regionSchemaIdRef) {
        // Case 1: Region is defined in schema
        if (agentProvidedMetadata) {
            finalMetadataPayload = await reorderFieldsBySchema(agentProvidedMetadata, regionSchemaIdRef, 'content', axiosInstance);
        } else {
            // Always provide empty metadata if defined
            finalMetadataPayload = { "$type": "FieldsValueDictionary" };
        }
    } else if (agentProvidedMetadata) {
        // Case 2: Region not defined but metadata provided (Error)
        throw new Error(`Metadata provided for Region '${name}', but that Region has no RegionSchema defined in the parent.`);
    } else {
        // Case 3: Region not defined, no metadata (Ad-hoc empty)
        finalMetadataPayload = { "$type": "FieldsValueDictionary" };
    }

    // 3. Process Nested Regions (Recursion)
    // We pass the *current* region's schema ID as the container for the next level
    let nestedRegions: any[] = [];
    if (regionSchemaIdRef) {
        // RECURSION: This will auto-fill children of THIS region if they are missing
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
}