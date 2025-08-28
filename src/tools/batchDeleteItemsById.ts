import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchDeleteItemsById = {
    name: "batchDeleteItemsById",
    description: `Starts an asynchronous process to permanently delete a batch of items from the Content Manager. This is more efficient than deleting items individually. If an item cannot be deleted (e.g., it is used by another item), it will be skipped, but the batch process will continue. The initial response includes a batch ID that can be used to monitor the status of the operation.`,
    input: {
        itemIds: z.array(z.string().regex(/^tcm:\d+-\d+(-\d+)?(-v\d+)?$/))
            .describe("An array of unique IDs (TCM URIs) for the items to be deleted. To delete specific versions, include the version number in the URI (e.g., 'tcm:5-263-64-v3')."),
    },
    execute: async ({ itemIds }: { itemIds: string[] }) => {
        try {
            // The API expects the item IDs in a request body with an 'Ids' property.
            const requestModel = { Ids: itemIds };
            const response = await authenticatedAxios.post('/batch/delete', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch deletion process started for ${itemIds.length} items.\n\n${JSON.stringify(response.data, null, 2)}`
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