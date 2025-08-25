import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

export const updateContentById = {
    name: "updateContentById",
    description: `Updates the content fields for an item of type 'Component' in the Content Management System.

Important Constraints:
- This tool is only for Components. It cannot update other item types (e.g., 'Page', 'Folder', 'Schema').
- This tool only updates the content fields and cannot be used to update other Component properties like Title, or Metadata.
- The content fields must be a JSON object with keys corresponding to the field names. The order of these fields must match the exact order defined in the Component's schema.

To update metadata for components or other item types, use the 'updateMetadataById' tool.
To update other properties, use the 'updateItemById' tool.
If the component is locked by another user, the operation will be aborted.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?)$/).describe("The unique ID of the component to update (e.g., 'tcm:5-123'). The item type (16) is optional and usually not provided."),
        content: z.record(fieldValueSchema).describe("A JSON object containing the Component's content fields. IMPORTANT: The order of the fields in this object MUST exactly match the order defined in the Schema. This ordering requirement also applies to any fields within an embedded schema field."),
    },
    examples: [
        {
            input: {
                "itemId": "tcm:5-123",
                "content": {
                    "TitleField": "Component Title",
                    "Abstract": "<p>The <em>quick</em> brown fox jumped over the lazy dog.</p>",
                    "Tags": [
                        "AI",
                        "Google",
                        "Machine Learning"
                    ]
                }
            },
            description: "Updates the values of the content fields with XML names 'TitleField', 'Abstract', and 'Tags'."
        }
    ],
    execute: async ({ itemId, content }: { itemId: string, content: Record<string, any> }) => {
        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');

        try {
            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            if (whoAmIResponse.status !== 200) {
                return handleUnexpectedResponse(whoAmIResponse);
            }
            const agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) {
                return handleAxiosError(new Error("Could not retrieve agent's user ID from whoAmI endpoint."), "Failed to update component");
            }

            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: {
                    useDynamicVersion: true
                }
            });
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            const item = getItemResponse.data;
            const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;
            let itemToUpdate;

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

            if (content) {
                itemToUpdate.Content = content;
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }

            const checkInRequestModel = {
                "$type": "CheckInRequest",
                "RemovePermanentLock": true
            };
            const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, checkInRequestModel);
            if (checkInResponse.status === 200) {
                return {
                    content: [{ type: "text", text: `Successfully updated and checked in component ${itemId}.` }],
                };
            } else {
                return handleUnexpectedResponse(checkInResponse);
            }
        } catch (error) {
            if (wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                    console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }

            return handleAxiosError(error, "Failed to update component");
        }
    }
};