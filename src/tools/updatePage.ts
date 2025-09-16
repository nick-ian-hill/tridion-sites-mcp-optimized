import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { processComponentPresentations, processRegions } from "../utils/pageUtils.js";

export const updatePage = {
    name: "updatePage",
    description: `Updates an existing Page in the Content Management System (CMS).
This tool can modify various aspects of a Page, including its title, file name, metadata, Component Presentations, and Regions.
Check-out and check-in are handled automatically. If the Page is locked by another user, the operation will be aborted.

IMPORTANT: When updating 'componentPresentations' or 'regions', the entire existing set of CPs or regions on the page will be replaced by the new values provided. To reorder or remove an item, you must provide the complete, modified list. The content provided must adhere to any constraints defined in the Page Template's Region Schemas, such as limits on the number of items or allowed Component/Template types.

Examples:

Example 1: Update the title and file name of a Page.
    const result = await tools.updatePage({
        itemId: "tcm:1-123-64",
        title: "New About Us Title",
        fileName: "new-about-us.html"
    });

Example 2: Update the metadata of a Page.
    const result = await tools.updatePage({
        itemId: "tcm:1-123-64",
        metadata: {
            "seoTitle": "Updated SEO Title",
            "seoDescription": "This is the new description for SEO."
        }
    });

Example 3: Reorder Component Presentations in a specific Region.
    const result = await tools.updatePage({
        itemId: "tcm:1-123-64",
        regions: JSON.stringify([
            {
                "$type": "EmbeddedRegion",
                "RegionName": "Main",
                "ComponentPresentations": [
                    { "$type": "ComponentPresentation", "Component": { "$type": "Link", "IdRef": "tcm:1-201-16" }, "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-202-32" } },
                    { "$type": "ComponentPresentation", "Component": { "$type": "Link", "IdRef": "tcm:1-101-16" }, "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-102-32" } }
                ]
            }
        ])
    });
`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+-64$/).describe("The unique ID (TCM URI) of the Page to update."),
        title: z.string().optional().describe("The new title for the Page."),
        fileName: z.string().regex(/^\S+$/, "File name cannot contain white space.").optional().describe("The new file name for the page (e.g., 'new-page.html'), which cannot contain spaces."),
        pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the Page Template to be associated with the Page. Replaces the existing Page Template."),
        metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of a Schema from which to look up the Page's metadata fields. If the Page Template defines a Region Schema, then that Region Schema can be set as the value of the metadataSchemaId. Alternatively, any schema with purpose 'metadata' can be selected."),
        metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields, matching the Metadata Schema. Replaces existing metadata."),
        componentPresentations: z.string().optional().describe("A JSON string representing a complete array of Component Presentation objects to replace the existing ones on the page. Use JSON.stringify() to format this correctly."),
        regions: z.string().optional().describe("A JSON string representing a complete array of Region objects to replace the existing ones on the page. Use JSON.stringify() to format this correctly.")
    },
    execute: async (params: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
        let wasCheckedOutByTool = false;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            let itemToUpdate = getItemResponse.data;

            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            if (whoAmIResponse.status !== 200) return handleUnexpectedResponse(whoAmIResponse);
            const agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) throw new Error("Could not retrieve agent's user ID.");

            const isCheckedOut = itemToUpdate?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = itemToUpdate?.VersionInfo?.CheckOutUser?.IdRef;

            if (isCheckedOut && checkedOutUser !== agentId) {
                return { content: [{ type: "text", text: `Page ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }] };
            }

            if (!isCheckedOut) {
                const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, { "$type": "CheckOutRequest", "SetPermanentLock": true });
                if (checkOutResponse.status !== 200) return handleUnexpectedResponse(checkOutResponse);
                itemToUpdate = checkOutResponse.data;
                wasCheckedOutByTool = true;
            }

            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.fileName) itemToUpdate.FileName = updates.fileName;

            if (updates.pageTemplateId) {
                const contextualPageTemplateId = convertItemIdToContextPublication(updates.pageTemplateId, itemId);
                itemToUpdate.PageTemplate = toLink(contextualPageTemplateId);
                itemToUpdate.IsPageTemplateInherited = false;
            }

            if (updates.metadataSchemaId) {
                const contextualMetadataSchemaId = convertItemIdToContextPublication(updates.metadataSchemaId, itemId);
                itemToUpdate.MetadataSchema = toLink(contextualMetadataSchemaId);
            }

            if (updates.metadata) {
                let schemaIdForMetadata = itemToUpdate.MetadataSchema?.IdRef;
                if (!schemaIdForMetadata) {
                    const ptResponse = await authenticatedAxios.get(`/items/${itemToUpdate.PageTemplate.IdRef.replace(':', '_')}`);
                    if (ptResponse.data?.PageSchema?.IdRef) {
                        schemaIdForMetadata = ptResponse.data.PageSchema.IdRef;
                    }
                }
                 if (!schemaIdForMetadata) {
                    throw new Error(`Could not determine a Metadata Schema for Page ${itemId}. Please specify a 'metadataSchemaId'.`);
                }
                const orderedMetadata = await reorderFieldsBySchema(updates.metadata, schemaIdForMetadata, 'metadata', authenticatedAxios);
                itemToUpdate.Metadata = orderedMetadata;
            }

            if (updates.componentPresentations) {
                 try {
                    const parsedCPs = JSON.parse(updates.componentPresentations);
                    itemToUpdate.ComponentPresentations = processComponentPresentations(parsedCPs, itemId);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`The 'componentPresentations' parameter is not a valid JSON string. Details: ${errorMessage}`);
                }
            }
            
            if (updates.regions) {
                try {
                    const parsedRegions = JSON.parse(updates.regions);
                    const pageTemplateId = itemToUpdate.PageTemplate?.IdRef;
                    if (!pageTemplateId) {
                        throw new Error(`Could not determine the Page Template for Page ${itemId} to process regions.`);
                    }
                    itemToUpdate.Regions = await processRegions(parsedRegions, itemId, pageTemplateId, authenticatedAxios);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`The 'regions' parameter is not a valid JSON string. Details: ${errorMessage}`);
                }
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }
            const updatedItem = updateResponse.data;

            if (wasCheckedOutByTool) {
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
                if (checkInResponse.status !== 200) {
                    return handleUnexpectedResponse(checkInResponse);
                }
            }
            
            return {
                content: [{ type: "text", text: `Successfully updated Page ${itemId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
            };

        } catch (error) {
            if (wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }
            return handleAxiosError(error, `Failed to update Page ${itemId}`);
        }
    }
};