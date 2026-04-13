import { z } from "zod";
import axios from "axios";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi } from "../utils/fieldReordering.js";
import { processComponentPresentations, processRegions } from "../utils/pageUtils.js";
import { componentPresentationSchemaForTyping, regionSchemaForTyping, RegionForTyping } from "../schemas/pageSchemas.js";
import { linkSchema } from "../schemas/linkSchema.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

const componentPresentationUpdateOperationSchema = z.object({
    regionPath: z.string().optional().describe("The path to the target region (e.g., 'Main' or 'Main/Sidebar'). If omitted or empty, the operation applies to the Page's top-level Component Presentations."),
    addComponentPresentations: z.array(componentPresentationSchemaForTyping).optional().describe("An array of Component Presentations to ADD to the target location."),
    removeComponentPresentations: z.array(z.object({
        Component: linkSchema,
        ComponentTemplate: linkSchema.optional()
    })).optional().describe("An array of Component Presentations to REMOVE from the target location. Matching is done by Component ID (and Component Template ID if provided).")
});

const updatePageInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+-64$/).describe("The unique ID (TCM URI) of the Page to update."),
    title: z.string().optional().describe("The new title for the Page."),
    fileName: z.string().regex(/^\S+$/, "File name cannot contain white space.").optional().describe("The new file name for the page (e.g., 'new-page.html'), which cannot contain spaces."),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the Page Template to be associated with the Page. Use 'search' or 'getItemsInContainer' to find available templates. If not provided, the page will use the Page Template defined by the parent Structure Group. In addition to defining how the page should be rendered (via Template Building Blocks), the Page Template can also specify a Region Schema which can define the structure of the Page."),
    metadataSchemaId: z.string().regex(/^(tcm:\d+-\d+-8|tcm:0-0-0)$/).optional().describe("The TCM URI of a Schema for the Page's metadata. Replaces the existing schema. If the Page Template defines a Region Schema, that Region Schema can be used here. Pass 'tcm:0-0-0' to remove the metadata schema."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields. Can be provided alongside 'metadataSchemaId'. Replaces existing metadata."),
    componentPresentations: z.array(componentPresentationSchemaForTyping).optional().describe("A complete array of Component Presentation objects to REPLACE the existing ones on the top-level of the page. WARNING: This overwrites the entire list."),
    regions: z.array(regionSchemaForTyping).optional().describe("A complete array of Region objects to replace the existing region data. WARNING: This overwrites the entire region structure."),
    componentPresentationUpdates: z.array(componentPresentationUpdateOperationSchema).optional().describe("A list of atomic operations to Add or Remove Component Presentations from the Page or specific Regions. Use this for safe updates in loops or partial modifications."),
    overrideRegionOrder: z.boolean().optional().describe("If true, the regions will be ordered exactly as provided in the 'regions' array. If false or omitted, the tool preserves the page's EXISTING region order (unlike createPage, which follows schema order by default).")
};

const updatePageInputSchema = z.object(updatePageInputProperties).refine(
    (data) => !(data.componentPresentations && data.componentPresentationUpdates),
    {
        message: "Validation Error: You cannot provide 'componentPresentations' (Full Replace) at the same time as 'componentPresentationUpdates' (Atomic Update). Please choose one strategy.",
        path: ["componentPresentations"]
    }
);

type UpdatePageInput = z.infer<typeof updatePageInputSchema>;

function applyUpdatesToList(
    currentList: any[], 
    additions: any[] | undefined, 
    removals: any[] | undefined, 
    contextId: string
): any[] {
    let updatedList = [...(currentList || [])];

    // 1. Process Removals
    if (removals && removals.length > 0) {
        // Map input IDs to current context to ensure matching works
        const targetsToRemove = removals.map((t: any) => ({
            compId: convertItemIdToContextPublication(t.Component.IdRef, contextId),
            tempId: t.ComponentTemplate ? convertItemIdToContextPublication(t.ComponentTemplate.IdRef, contextId) : null
        }));

        updatedList = updatedList.filter((cp: any) => {
            return !targetsToRemove.some((target: any) => {
                const compMatch = target.compId === cp.Component.IdRef;
                // If template is specified in removal, strict match. If not, match only component.
                const tempMatch = target.tempId 
                    ? target.tempId === cp.ComponentTemplate?.IdRef
                    : true;
                return compMatch && tempMatch;
            });
        });
    }

    // 2. Process Additions
    if (additions && additions.length > 0) {
        const cpsToAdd = processComponentPresentations(additions, contextId);
        updatedList.push(...cpsToAdd);
    }

    return updatedList;
}

/**
 * Recursively finds a region in the region structure based on a path.
 * @param regions The array of regions to search.
 * @param pathParts The path segments (e.g., ["Main", "Sidebar"]).
 * @returns The found Region object or undefined.
 */
function findTargetRegion(regions: any[], pathParts: string[]): any | undefined {
    if (!regions || pathParts.length === 0) return undefined;

    const currentName = pathParts[0];
    const target = regions.find((r: any) => r.RegionName === currentName);

    if (!target) return undefined;

    // If this was the last part of the path, we found it.
    if (pathParts.length === 1) {
        return target;
    }

    // Otherwise, recurse into nested regions
    return findTargetRegion(target.Regions, pathParts.slice(1));
}


export const updatePage = {
    name: "updatePage",
    summary: "Updates an existing Page's properties and its collection of Component Presentations. Use this to reorder content or change templates.",
    description: `Updates an existing Page in the Content Management System (CMS).
This tool can modify various aspects of a Page, including its title, file name, metadata, Component Presentations, and Regions.
Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in. If the item is already checked out by you, it will remain checked out after the update. The operation will be aborted if the item is checked out by another user.

STRATEGIES FOR UPDATING CONTENT:
1. Full Replacement: Use 'componentPresentations' (for top-level) or 'regions' (for nested content). This completely overwrites the existing data with what you provide. 
   *Region Order Note:* When using full replacement for regions, the tool will automatically preserve the page's EXISTING region order. Any new mandatory regions added to the Schema since the page was last updated will be appended to the end.
2. Atomic Updates (Recommended): Use 'componentPresentationUpdates'. This allows you to Add or Remove specific items from the Page or specific Regions without touching the rest of the content.
3. Structural Reordering: To explicitly change the order of the regions themselves, use Full Replacement (strategy 1) and set 'overrideRegionOrder: true'.

Constraints:
- The content provided must adhere to any constraints defined in the Page Template's Region Schemas.
- For atomic updates, the target Region must already exist on the Page.

Best Practice — Swapping the Page Template:
If you change 'pageTemplateId' to a template that requires a different metadata schema, you MUST provide the new 'metadataSchemaId' (and any mandatory 'metadata' values) in the SAME call. Splitting this into two sequential updates (template first, then schema) will cause the first update to fail if the new template enforces schema constraints.

Verification: API success (200 OK) guarantees the request was received, but not necessarily that complex nested structures (like Regions) were populated as intended. For critical updates, you should fetch the item using getItem to verify the changes were persisted correctly before reporting completion to the user.
If called from the toolOrchestrator, consider auditing one or more updated pages to validate that the script performed as intended.

`,
    examples: [
        {
            description: "Update the title and file name of a Page.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    title: "New About Us Title",
    fileName: "new-about-us.html"
});`
        },
        {
            description: "Update metadata.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    metadata: { "seoTitle": "Updated Title" }
});`
        },
        {
            description: "Reorder Component Presentations in a specific Region.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    regions: [
        {
            "type": "EmbeddedRegion",
            "RegionName": "Main",
            "ComponentPresentations": [
                { "type": "ComponentPresentation", "Component": { "type": "Link", "IdRef": "tcm:1-201-16" }, "ComponentTemplate": { "type": "Link", "IdRef": "tcm:1-202-32" } },
                { "type": "ComponentPresentation", "Component": { "type": "Link", "IdRef": "tcm:1-101-16" }, "ComponentTemplate": { "type": "Link", "IdRef": "tcm:1-102-32" } }
            ]
        }
    ]
});`
        },
        {
            description: "Atomically Add a Component to the 'Main' Region.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    componentPresentationUpdates: [
        {
            "regionPath": "Main",
            "addComponentPresentations": [
                { 
                    "type": "ComponentPresentation", 
                    "Component": { "type": "Link", "IdRef": "tcm:1-500-16" }, 
                    "ComponentTemplate": { "type": "Link", "IdRef": "tcm:1-202-32" } 
                }
            ]
        }
    ]
});`
        },
        {
            description: "Remove a specific Component from the top-level Page.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    componentPresentationUpdates: [
        {
            "removeComponentPresentations": [
                { "Component": { "type": "Link", "IdRef": "tcm:1-999-16" } }
            ]
        }
    ]
});`
        },
        {
            description: "Change the Metadata Schema and provide metadata for the new fields. Specifying metadata values with this tool is necessary when the new metadata schema has mandatory fields.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    metadataSchemaId: "tcm:1-987-8",
    metadata: {
        "pageType": "Landing Page",
        "campaignCode": "Q4-2025"
    }
});`
        },
        {
            description: "Remove the Metadata Schema from a Page.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    metadataSchemaId: "tcm:0-0-0"
});`
        },
        {
            description: "Reorder the structural Regions on a Page. To move the 'Sidebar' region above the 'Main' region, you must perform a full replacement and explicitly set 'overrideRegionOrder' to true.",
            payload: `const result = await tools.updatePage({
    itemId: "tcm:1-123-64",
    overrideRegionOrder: true,
    regions: [
        { 
            "type": "EmbeddedRegion", 
            "RegionName": "Sidebar",
            "ComponentPresentations": [ /* existing sidebar content */ ]
        },
        { 
            "type": "EmbeddedRegion", 
            "RegionName": "Main",
            "ComponentPresentations": [ /* existing main content */ ]
        }
    ]
});`
        }
    ],
    input: updatePageInputProperties,
    
    execute: async (params: UpdatePageInput, context: any) => {
        // Validate Zod schema first to catch conflicting parameters
        try {
            updatePageInputSchema.parse(params);
        } catch (validationError: any) {
            const errorResponse = {
                type: "Error",
                Message: `Validation Error: ${validationError.errors?.[0]?.message || validationError.message}`
            };
            return {
                content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }]
            };
        }

        formatForApi(params);
        const diagnosticsArgs = JSON.parse(JSON.stringify(params));
        
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            const itemToUpdate = getItemResponse.data;

            // --- Basic Properties ---
            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.fileName) itemToUpdate.FileName = updates.fileName;

            if (updates.pageTemplateId) {
                const contextualPageTemplateId = convertItemIdToContextPublication(updates.pageTemplateId, itemId);
                itemToUpdate.PageTemplate = toLink(contextualPageTemplateId);
                itemToUpdate.IsPageTemplateInherited = false;
            }

            // --- Metadata Logic ---
            if (updates.metadataSchemaId) {
                if (updates.metadataSchemaId === 'tcm:0-0-0') {
                    itemToUpdate.MetadataSchema = toLink('tcm:0-0-0');
                    delete itemToUpdate.Metadata;
                } else {
                    const contextualMetadataSchemaId = convertItemIdToContextPublication(updates.metadataSchemaId, itemId);
                    itemToUpdate.MetadataSchema = toLink(contextualMetadataSchemaId);
                }
            }

            if (updates.metadata && updates.metadataSchemaId !== 'tcm:0-0-0') {
                let schemaIdForMetadata = updates.metadataSchemaId;
                
                if (!schemaIdForMetadata) {
                     schemaIdForMetadata = itemToUpdate.MetadataSchema?.IdRef;
                }
                
                if (!schemaIdForMetadata || schemaIdForMetadata === 'tcm:0-0-0') {
                    const pageTemplateId = itemToUpdate.PageTemplate?.IdRef;
                    if (pageTemplateId) {
                         try {
                             const ptResponse = await authenticatedAxios.get(`/items/${pageTemplateId.replace(':', '_')}`);
                             if (ptResponse.data?.PageSchema?.IdRef) {
                                schemaIdForMetadata = ptResponse.data.PageSchema.IdRef;
                             }
                         } catch (e) {
                             console.warn(`Could not load Page Template ${pageTemplateId} to check for Region Schema fallback.`);
                         }
                    }
                }
                
                if (!schemaIdForMetadata || schemaIdForMetadata === 'tcm:0-0-0') {
                    throw new Error(`Could not determine a valid Schema for the metadata fields of item ${itemId}.`);
                }
                
                convertLinksRecursively(updates.metadata, itemId);
                const orderedMetadata = await reorderFieldsBySchema(updates.metadata, schemaIdForMetadata, 'metadata', authenticatedAxios);
                itemToUpdate.Metadata = orderedMetadata;
            }

            if (updates.componentPresentations) {
                itemToUpdate.ComponentPresentations = processComponentPresentations(updates.componentPresentations, itemId);
            }
            if (updates.regions) {
                const pageTemplateId = itemToUpdate.PageTemplate?.IdRef;
                if (!pageTemplateId) {
                    throw new Error(`Could not determine the Page Template for Page ${itemId} to process regions.`);
                }
                
                // Extract the existing regions to preserve their custom order
                const existingRegions = itemToUpdate.Regions || [];
                
                // Pass existingRegions as the final parameter
                itemToUpdate.Regions = await processRegions(
                    updates.regions as RegionForTyping[], 
                    itemId, 
                    pageTemplateId, 
                    authenticatedAxios, 
                    updates.overrideRegionOrder,
                    existingRegions
                );
            }
            // --- Atomic Update Logic (General) ---
            if (updates.componentPresentationUpdates) {
                for (const operation of updates.componentPresentationUpdates) {
                    const { regionPath, addComponentPresentations, removeComponentPresentations } = operation;

                    // Case A: Page Level (No path or empty path)
                    if (!regionPath || regionPath.trim() === "") {
                        itemToUpdate.ComponentPresentations = applyUpdatesToList(
                            itemToUpdate.ComponentPresentations,
                            addComponentPresentations,
                            removeComponentPresentations,
                            itemId
                        );
                    } 
                    // Case B: Region Level
                    else {
                        const pathParts = regionPath.split('/');
                        const targetRegion = findTargetRegion(itemToUpdate.Regions, pathParts);

                        if (!targetRegion) {
                            throw new Error(`Atomic Update Failed: Region '${regionPath}' not found on Page ${itemId}. Ensure the region exists or use the 'regions' parameter to create the structure first.`);
                        }

                        targetRegion.ComponentPresentations = applyUpdatesToList(
                            targetRegion.ComponentPresentations,
                            addComponentPresentations,
                            removeComponentPresentations,
                            itemId
                        );
                    }
                }
            }

            // --- Commit Changes ---
            // First attempt. If the CMS rejects the PUT because a region is no longer in the schema
            // ("Unexpected region" error — caused by a schema change after the page was last saved),
            // strip the stale region(s) and retry once. This avoids paying the schema lookup cost
            // on every call when stale regions are rare.
            let updateResponse: any;
            try {
                updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            } catch (putError) {
                const isStaleRegionError =
                    axios.isAxiosError(putError) &&
                    putError.response &&
                    JSON.stringify(putError.response.data).toLowerCase().includes('unexpected region');

                if (isStaleRegionError && (itemToUpdate.Regions as any[])?.length > 0) {
                    const pageTemplateId = itemToUpdate.PageTemplate?.IdRef;
                    if (pageTemplateId) {
                        const ptResponse = await authenticatedAxios.get(`/items/${pageTemplateId.replace(':', '_')}`);
                        const pageSchemaId = ptResponse.data?.PageSchema?.IdRef;
                        if (pageSchemaId) {
                            const schemaResponse = await authenticatedAxios.get(`/items/${pageSchemaId.replace(':', '_')}`);
                            const validNames = new Set<string>(
                                (schemaResponse.data?.RegionDefinition?.NestedRegions || [])
                                    .map((r: any) => r.RegionName as string)
                            );
                            const staleNames = (itemToUpdate.Regions as any[])
                                .filter((r: any) => !validNames.has(r.RegionName))
                                .map((r: any) => r.RegionName as string);
                            if (staleNames.length > 0) {
                                itemToUpdate.Regions = (itemToUpdate.Regions as any[]).filter((r: any) => validNames.has(r.RegionName));
                                updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
                            } else {
                                throw putError;
                            }
                        } else {
                            throw putError;
                        }
                    } else {
                        throw putError;
                    }
                } else {
                    throw putError;
                }
            }
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }
            const updatedItem = updateResponse.data;

            const responseData = {
                type: updatedItem['$type'],
                Id: updatedItem.Id,
                Message: `Successfully updated ${updatedItem.Id}`
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            await diagnoseBluePrintError(error, diagnosticsArgs, params.itemId, authenticatedAxios);
            return handleAxiosError(error, `Failed to update Page ${itemId}`);
        }
    }
};