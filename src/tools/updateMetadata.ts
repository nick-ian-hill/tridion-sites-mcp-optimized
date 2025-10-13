import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";
import { handleCheckout, checkInItem, undoCheckoutItem } from "../utils/versioningUtils.js";

export const updateMetadata = {
    name: "updateMetadata",
    description: `Updates the metadata fields for a specific item in the Content Management System. Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in. If the item is already checked out by you, it will remain checked out after the update. The operation will be aborted if the item is checked out by another user.

Important Constraints:
- This tool only updates the metadata fields. It cannot update the item's Title or Content fields.

To update content fields for a component, use the 'updateContent' tool instead.
To update other properties, use the 'updateItemProperties', 'updatePage', or 'updatePublication' tool depending on the item type.

Examples:

Example 1: Updates the metadata fields with XML names 'Keywords' and 'Author' for a Component.
    const result = await tools.updateMetadata({
        "itemId": "tcm:5-123",
        "metadata": {
            "Keywords": ["Update", "Tool", "Metadata"],
            "Author": "Author Name"
        }
    });
    
Example 2: Updates the metadata values for a 'Folder' with featuring a multi-value embedded schema field.
    const result = await tools.updateMetadata({
        "itemId": "tcm:4-567-2",
        "metadata": {
            "Products": [
                {
                    "Description": {
                        $type: "Link",
                        IdRef: "tcm:4-101",
                        Title: "Product A"
                    },
                    "AvailableFrom": "2025-10-02T00:00:00"
                },
                {
                    "Description": {
                        $type: "Link",
                        IdRef: "tcm:4-102",
                        Title: "Product B"
                    },
                    "AvailableFrom": "2025-10-02T00:00:00"
                }
            ],
        }
    });
    `,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item to update (e.g., 'tcm:5-1234-64')."),
        metadata: z.record(fieldValueSchema).describe("A JSON object containing the item's metadata fields. The tool will automatically order the fields to match the Metadata Schema definition."),
    },
    execute: async ({ itemId, metadata }: { itemId: string, metadata: Record<string, any> }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            
            const item = getItemResponse.data;
            let itemToUpdate = item;
            const isVersioned = !!item?.VersionInfo?.Version;
            
            let schemaIdForMetadata: string | undefined;

            if (item.MetadataSchema?.IdRef && item.MetadataSchema.IdRef !== 'tcm:0-0-0') {
                schemaIdForMetadata = item.MetadataSchema.IdRef;
            } 
            else if (item.$type === 'Component') {
                schemaIdForMetadata = item.Schema?.IdRef;
            }
            
            if (!schemaIdForMetadata) {
                return handleAxiosError(new Error(`Could not determine a valid Schema for the metadata fields of item ${itemId}.`), "Failed to update item metadata");
            }
            
            if (isVersioned) {
                const versioningResult = await handleCheckout(itemId, item, authenticatedAxios);
                if (versioningResult.error) {
                    return { content: [{ type: "text", text: versioningResult.error }] };
                }
                itemToUpdate = versioningResult.item;
                wasCheckedOutByTool = versioningResult.wasCheckedOutByTool;
            }

            convertLinksRecursively(metadata, itemId);
            const orderedMetadata = await reorderFieldsBySchema(metadata, schemaIdForMetadata, 'metadata', authenticatedAxios);
            
            itemToUpdate.Metadata = orderedMetadata;

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }

            if (wasCheckedOutByTool) {
                const checkInResult = await checkInItem(itemId, authenticatedAxios);
                if (!('status' in checkInResult && checkInResult.status === 200)) {
                    return checkInResult;
                }
            }

            return {
                content: [{ type: "text", text: `Successfully updated metadata for item ${itemId}.` }],
            };
        } catch (error) {
            if (wasCheckedOutByTool) {
                await undoCheckoutItem(itemId, authenticatedAxios);
            }
            return handleAxiosError(error, "Failed to update item metadata");
        }
    }
};