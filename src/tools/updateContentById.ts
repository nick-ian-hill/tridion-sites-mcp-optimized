import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";

export const updateContentById = {
    name: "updateContentById",
    description: `Updates the content fields for an item of type 'Component' in the Content Management System.

Important Constraints:
- This tool is only for Components. It cannot update other item types.
- This tool only updates the content fields and cannot be used to update other properties like Title or Metadata.

To update metadata, use the 'updateMetadataById' tool.
To update other properties, use the 'updateItemById' tool.
If the component is locked by another user, the operation will be aborted.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?)$/).describe("The unique ID of the component to update (e.g., 'tcm:5-123')."),
        content: z.record(fieldValueSchema).describe("A JSON object containing the Component's content fields. The tool will automatically order the fields to match the Schema definition."),
    },
    examples: [
        {
            input: {
                "itemId": "tcm:5-123",
                "content": {
                    "TitleField": "Component Title",
                    "Abstract": "<p>The <em>quick</em> brown fox jumped over the lazy dog.</p>",
                    "Tags": ["AI", "Google", "Machine Learning"]
                }
            },
            description: "Updates the values of the content fields with XML names 'TitleField', 'Abstract', and 'Tags'."
        }
    ],
    execute: async ({ itemId, content }: { itemId: string, content: Record<string, any> }) => {
        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');

        try {
            const getInitialItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getInitialItemResponse.status !== 200) {
                return handleUnexpectedResponse(getInitialItemResponse);
            }
            const initialItem = getInitialItemResponse.data;
            const schemaId = initialItem.Schema?.IdRef;

            if (!schemaId) {
                return handleAxiosError(new Error(`Component ${itemId} does not have an associated Schema.`), "Failed to update component");
            }

            convertLinksRecursively(content, itemId);
            
            const orderedContent = await reorderFieldsBySchema(content, schemaId, 'content');

            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            if (whoAmIResponse.status !== 200) return handleUnexpectedResponse(whoAmIResponse);
            const agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) return handleAxiosError(new Error("Could not retrieve agent's user ID."), "Failed to update component");

            const isCheckedOut = initialItem?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = initialItem?.VersionInfo?.CheckOutUser?.IdRef;
            let itemToUpdate;

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
                itemToUpdate = initialItem;
            }

            itemToUpdate.Content = orderedContent;

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }

            const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
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
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }
            return handleAxiosError(error, "Failed to update component");
        }
    }
};
