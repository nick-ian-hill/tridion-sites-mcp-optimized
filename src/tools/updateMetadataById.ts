import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

export const updateMetadataById = {
    name: "updateMetadataById",
    description: `Updates the metadata fields for a specific item in the Content Management System.

Important Constraints:
- This tool only updates the metadata fields. It cannot update the item's Title or Content fields.
- The metadata fields must be a JSON object with keys corresponding to the field names. The order of these fields must match the exact order defined in the item's schema.

To update content fields for a component, use the 'updateContentById' tool instead.
To update other properties, use the 'updateItemById' tool.
If a versioned item is locked by another user, the operation will be aborted.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item to update (e.g., 'tcm:5-1234-64')."),
        metadata: z.record(fieldValueSchema).describe("A JSON object containing the item's metadata fields. IMPORTANT: The order of the fields in this object MUST exactly match the order defined in the Schema. This ordering requirement also applies to any fields within an embedded schema field."),
    },
    examples: [
        {
            input: {
                "itemId": "tcm:5-123",
                "metadata": {
                    "Keywords": [
                        "Update",
                        "Tool",
                        "Metadata"
                    ],
                    "Author": "Author Name"
                }
            },
            description: "Updates the metadata fields with XML names 'Keywords' and 'Author' for a Component."
        },
        {
            input: {
                "itemId": "tcm:5-456-64",
                "metadata": {
                    "Author": "Author Name",
                    "Description": "This page was updated to include new metadata fields.",
                    "LastUpdatedByTool": true
                }
            },
            description: "Updates the metadata fields with XML names 'Author', 'Description', and 'LastUpdatedByTool' for a Page."
        }
    ],
    execute: async ({ itemId, metadata }: { itemId: string, metadata: Record<string, any> }) => {
        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');

        try {
            // Get item data first to determine if it's a versioned item
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: {
                    useDynamicVersion: true
                }
            });
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            const item = getItemResponse.data;
            let itemToUpdate;

            // Check if the item is versioned to decide if checkout is needed
            const isVersioned = !!item?.VersionInfo?.Version;

            if (isVersioned) {
                const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
                if (whoAmIResponse.status !== 200) {
                    return handleUnexpectedResponse(whoAmIResponse);
                }
                const agentId = whoAmIResponse.data?.User?.Id;
                if (!agentId) {
                    return handleAxiosError(new Error("Could not retrieve agent's user ID from whoAmI endpoint."), "Failed to update item metadata");
                }

                const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
                const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;
                
                if (isCheckedOut && checkedOutUser !== agentId) {
                    return {
                        content: [{
                            type: "text",
                            text: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.`
                        }],
                        errors: [],
                    };
                } else if (!isCheckedOut) {
                    const checkOutRequestModel = {
                        "$type": "CheckOutRequest",
                        "SetPermanentLock": true
                    };
                    const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, checkOutRequestModel);
                    if (checkOutResponse.status !== 200) {
                        return handleUnexpectedResponse(checkOutResponse);
                    }
                    itemToUpdate = checkOutResponse.data;
                    wasCheckedOutByTool = true;
                } else {
                    itemToUpdate = item;
                }
            } else {
                itemToUpdate = item;
            }

            if (metadata) {
                itemToUpdate.Metadata = metadata;
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }

            // Only attempt check-in if a checkout was performed
            if (wasCheckedOutByTool) {
                const checkInRequestModel = {
                    "$type": "CheckInRequest",
                    "RemovePermanentLock": true
                };
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, checkInRequestModel);
                if (checkInResponse.status !== 200) {
                    return handleUnexpectedResponse(checkInResponse);
                }
            }

            return {
                content: [{ type: "text", text: `Successfully updated metadata for item ${itemId}.` }],
            };
        } catch (error) {
            if (wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                    console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }
            return handleAxiosError(error, "Failed to update item metadata");
        }
    }
};