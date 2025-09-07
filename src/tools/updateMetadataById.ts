import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";

export const updateMetadataById = {
    name: "updateMetadataById",
    description: `Updates the metadata fields for a specific item in the Content Management System.

Important Constraints:
- This tool only updates the metadata fields. It cannot update the item's Title or Content fields.

To update content fields for a component, use the 'updateContentById' tool instead.
To update other properties, use the 'updateItemById', 'updatePage', or 'updatePublication' tool depending on the item type.
If a versioned item is locked by another user, the operation will be aborted.

Examples:

Example 1: Updates the metadata fields with XML names 'Keywords' and 'Author' for a Component.
    const result = await tools.updateMetadataById({
        "itemId": "tcm:5-123",
        "metadata": {
            "Keywords": ["Update", "Tool", "Metadata"],
            "Author": "Author Name"
        }
    });`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item to update (e.g., 'tcm:5-1234-64')."),
        metadata: z.record(fieldValueSchema).describe("A JSON object containing the item's metadata fields. The tool will automatically order the fields to match the Metadata Schema definition."),
    },
    execute: async ({ itemId, metadata }: { itemId: string, metadata: Record<string, any> }) => {
        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            
            const item = getItemResponse.data;
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
            
            convertLinksRecursively(metadata, itemId);

            const orderedMetadata = await reorderFieldsBySchema(metadata, schemaIdForMetadata, 'metadata');

            let itemToUpdate;
            const isVersioned = !!item?.VersionInfo?.Version;

            if (isVersioned) {
                const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
                if (whoAmIResponse.status !== 200) return handleUnexpectedResponse(whoAmIResponse);
                const agentId = whoAmIResponse.data?.User?.Id;
                if (!agentId) return handleAxiosError(new Error("Could not retrieve agent's user ID."), "Failed to update item metadata");

                const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
                const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;
                
                if (isCheckedOut && checkedOutUser !== agentId) {
                    return {
                        content: [{ type: "text", text: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }],
                        errors: [],
                    };
                } else if (!isCheckedOut) {
                    const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, { "$type": "CheckOutRequest", "SetPermanentLock": true });
                    if (checkOutResponse.status !== 200) return handleUnexpectedResponse(checkOutResponse);
                    itemToUpdate = checkOutResponse.data;
                    wasCheckedOutByTool = true;
                } else {
                    itemToUpdate = item;
                }
            } else {
                itemToUpdate = item;
            }

            itemToUpdate.Metadata = orderedMetadata;

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }

            if (wasCheckedOutByTool) {
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
                if (checkInResponse.status !== 200) return handleUnexpectedResponse(checkInResponse);
            }

            return {
                content: [{ type: "text", text: `Successfully updated metadata for item ${itemId}.` }],
            };
        } catch (error) {
            if (wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }
            return handleAxiosError(error, "Failed to update item metadata");
        }
    }
};
