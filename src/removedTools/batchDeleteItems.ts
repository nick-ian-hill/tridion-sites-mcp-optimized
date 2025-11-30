import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const batchDeleteItems = {
    name: "batchDeleteItems",
    description: `Starts an asynchronous process to permanently delete a batch of items from the Content Manager. This is more efficient than deleting items individually using the 'deleteItem' tool. The initial response includes a batch ID that can be used to monitor the status of the operation with the 'getBatchOperationStatus' tool.
To prevent failures, it's highly recommended to first check if an item is used by other items using the 'getDependencyGraph' tool with direction 'UsedBy'. An item that is in use cannot be deleted.`,
    input: {
        itemIds: z.array(z.string().regex(/^tcm:\d+-\d+(-\d+)?(-v\d+)?$/))
            .describe("An array of unique IDs (TCM URIs) for the items to be deleted. To delete specific versions, include the version number in the URI (e.g., 'tcm:5-263-64-v3')."),
        confirmed: z.boolean().optional().describe("Confirmation to proceed with the batch deletion."),
    },
    execute: async ({ itemIds, confirmed }: { itemIds: string[]; confirmed?: boolean },
        context: any
    ) => {
        if (!confirmed) {
            return {
                elicit: {
                    input: "confirmed",
                    content: [{
                        type: "text",
                        text: `Are you sure you want to permanently delete these ${itemIds.length} items? This action cannot be undone.`
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
            const requestModel = { ItemIds: itemIds };
            const response = await authenticatedAxios.post('/batch/delete', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                const formattedResponse = formatForAgent(response.data);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponse, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch deletion");
        }
    }
};