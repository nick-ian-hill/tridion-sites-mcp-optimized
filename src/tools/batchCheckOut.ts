import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchCheckOut = {
    name: "batchCheckOut",
    description: `Starts an asynchronous process to check out a batch of versioned items, making the items editable. This action locks each item for the current user, preventing others from editing them. The initial response includes a batch ID that can be used to monitor the status of the operation.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the versioned items to check out."),
        setPermanentLock: z.boolean().optional().default(true)
            .describe("Set to true to apply a permanent lock to each item that requires an explicit check-in or undo check-out to release."),
    },
    execute: async ({ itemIds, setPermanentLock }: { itemIds: string[]; setPermanentLock: boolean; }) => {
        try {
            const requestModel = {
                Ids: itemIds,
                SetPermanentLock: setPermanentLock
            };
            
            const response = await authenticatedAxios.post('/batch/checkOut', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch check-out process started for ${itemIds.length} items.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch check-out");
        }
    }
};