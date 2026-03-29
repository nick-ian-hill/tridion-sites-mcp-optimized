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
 * Processes regions by comparing user-provided regions against the Schema definition and existing state.
 * @param regions The array of regions provided by the user/agent.
 * @param contextId The Publication context ID.
 * @param containerId The ID of the container definition (Page Template ID or Region Schema ID).
 * @param axiosInstance Authenticated Axios instance.
 * @param overrideRegionOrder If true, honors the user's explicit order.
 * @param existingRegions The regions currently on the page (used to preserve order during updates).
 */
export async function processRegions(
    regions: RegionForTyping[] | undefined,
    contextId: string,
    containerId: string,
    axiosInstance: AxiosInstance,
    overrideRegionOrder: boolean = false,
    existingRegions?: any[]
): Promise<any[]> {

    // 1. Fetch the Container Item (Page Template or Region Schema)
    let containerItem: any;
    try {
        containerItem = (await axiosInstance.get(`/items/${containerId.replace(':', '_')}`)).data;
    } catch (e) {
        console.warn(`Failed to load container item ${containerId} for region processing: ${String(e)}. Auto-fill of missing regions will be disabled.`);
        if (!regions) return [];
        return Promise.all(regions.map(r => processSingleRegion(r, undefined, contextId, axiosInstance, overrideRegionOrder, existingRegions?.find((er: any) => er.RegionName === r.RegionName)?.Regions)));
    }

    // 2. Determine the "Region Schema" that defines the structure
    let definitionSchema: any;

    if (containerItem.$type === 'PageTemplate') {
        const pageSchemaId = containerItem.PageSchema?.IdRef;
        if (pageSchemaId) {
            try {
                definitionSchema = (await axiosInstance.get(`/items/${pageSchemaId.replace(':', '_')}`)).data;
            } catch (e) {
                console.warn(`Could not load Page Schema ${pageSchemaId} linked from Page Template ${containerId}.`);
            }
        }
    } else if (containerItem.$type === 'Schema' && containerItem.Purpose === 'Region') {
        definitionSchema = containerItem;
    }

    // 3. Merge User Regions with Schema Definitions
    const definedNestedRegions = definitionSchema?.RegionDefinition?.NestedRegions || [];
    const userRegions = regions || [];
    const processedRegions: any[] = [];

    // Validate all user regions exist in the schema
    for (const userRegion of userRegions) {
        const isValid = definedNestedRegions.some((def: any) => def.RegionName === userRegion.RegionName);
        if (!isValid) {
            const validNames = definedNestedRegions.map((r: any) => r.RegionName).join(", ");
            throw new Error(`Validation Error: The Page Template references a Region Schema that does not contain a nested region named '${userRegion.RegionName}'. Available regions are: [${validNames}].`);
        }
    }

    // 4. Determine Output Order Strategy
    let orderedNames: string[] = [];
    if (overrideRegionOrder) {
        // Rule (c): Follow input parameter order
        orderedNames = userRegions.map(r => r.RegionName);
        definedNestedRegions.forEach((def: any) => {
            if (!orderedNames.includes(def.RegionName)) orderedNames.push(def.RegionName);
        });
    } else if (existingRegions && existingRegions.length > 0) {
        // Rule (b): Follow existing page order
        orderedNames = existingRegions.map(r => r.RegionName);
        definedNestedRegions.forEach((def: any) => {
            // Append any newly added mandatory regions from the schema
            if (!orderedNames.includes(def.RegionName)) orderedNames.push(def.RegionName);
        });
    } else {
        // Rule (a): Follow schema order (New Page)
        orderedNames = definedNestedRegions.map((r: any) => r.RegionName);
    }

    // 5. Build Regions Array
    for (const regionName of orderedNames) {
        const def = definedNestedRegions.find((d: any) => d.RegionName === regionName);
        if (!def) continue; // Skip regions that were in existingRegions but removed from Schema

        const userRegion = userRegions.find(r => r.RegionName === regionName);
        const existingChildRegions = existingRegions?.find((r: any) => r.RegionName === regionName)?.Regions;

        if (userRegion) {
            processedRegions.push(await processSingleRegion(userRegion, definitionSchema, contextId, axiosInstance, overrideRegionOrder, existingChildRegions));
        } else {
            const emptyRegionData: RegionForTyping = {
                type: "EmbeddedRegion", RegionName: regionName, ComponentPresentations: [], Regions: []
            };
            processedRegions.push(await processSingleRegion(emptyRegionData, definitionSchema, contextId, axiosInstance, overrideRegionOrder, existingChildRegions));
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
    axiosInstance: AxiosInstance,
    overrideRegionOrder: boolean = false,
    existingNestedRegions?: any[]
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
        if (agentProvidedMetadata) {
            finalMetadataPayload = await reorderFieldsBySchema(agentProvidedMetadata, regionSchemaIdRef, 'metadata', axiosInstance);
        } else {
            finalMetadataPayload = { "$type": "FieldsValueDictionary" };
        }
    } else if (agentProvidedMetadata) {
        throw new Error(`Metadata provided for Region '${name}', but that Region has no RegionSchema defined in the parent.`);
    } else {
        finalMetadataPayload = { "$type": "FieldsValueDictionary" };
    }

    // 3. Process Nested Regions (Recursion)
    let nestedRegions: any[] = [];
    if (regionSchemaIdRef) {
        // Pass the existing structure down recursively
        nestedRegions = await processRegions(regionData.Regions, contextId, regionSchemaIdRef, axiosInstance, overrideRegionOrder, existingNestedRegions);
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