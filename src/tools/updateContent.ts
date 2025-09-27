import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";

export const updateContent = {
    name: "updateContent",
    description: `Updates the content fields for an item of type 'Component' in the Content Management System.

Important Constraints:
- This tool is only for Components. It cannot update other item types.
- This tool only updates the content fields and cannot be used to update other properties like Title or Metadata.

To update metadata, use the 'updateMetadata' tool.
To update other properties, use the 'updateItem' tool.
If the component is locked by another user, the operation will be aborted.

Examples:

Example 1: Updates the values of the content fields with XML names 'TitleField', 'Abstract', and 'Tags'.
    const result = await tools.updateContent({
        "itemId": "tcm:5-123",
        "content": {
            "TitleField": "Component Title",
            "Abstract": "<p>The <em>quick</em> brown fox jumped over the lazy dog.</p>",
            "Tags": ["AI", "Google", "Machine Learning"]
        }
    });`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?)$/).describe("The unique ID of the component to update (e.g., 'tcm:5-123')."),
        content: z.record(fieldValueSchema).describe("A JSON object containing the Component's content fields. The tool will automatically order the fields to match the Schema definition."),
    },
    execute: async ({ itemId, content }: { itemId: string, content: Record<string, any> }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

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
            
            const orderedContent = await reorderFieldsBySchema(content, schemaId, 'content', authenticatedAxios);

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