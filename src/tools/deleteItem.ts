import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const deleteItem = {
    name: "deleteItem",
    description: `Permanently deletes a single item from the Content Manager. For deleting multiple items, the 'batchDeleteItems' tool is more efficient.
IMPORTANT: The operation will fail if the item is used by other items in the system. To prevent this, it is highly recommended to first check for dependencies using the 'getDependencyGraph' tool with the direction set to 'UsedBy'.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?(-v\d+)?$/).describe("The unique ID (TCM URI) of the item to delete. To delete a specific version, include the version number in the URI (e.g., 'tcm:5-263-64-v3')."),
        confirmed: z.boolean().optional().describe("Confirmation to proceed with the deletion."),
    },
    execute: async ({ itemId, confirmed }: { itemId: string; confirmed?: boolean }, context: any) => {
        if (!confirmed) {
            return {
                elicit: {
                    input: "confirmed",
                    content: [{
                        type: "text",
                        text: `Are you sure you want to permanently delete the item ${itemId}? This action cannot be undone.`
                    }],
                }
            };
        }

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.delete(`/items/${escapedItemId}`);

            if (response.status === 204) {
                const responseData = {
                    type: 'Success',
                    Id: itemId,
                    Message: `Successfully deleted ${itemId}`
                };
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to delete item ${itemId}`);
        }
    }
};