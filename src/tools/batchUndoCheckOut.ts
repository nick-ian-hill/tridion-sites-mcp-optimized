import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchUndoCheckOut = {
    name: "batchUndoCheckOut",
    description: `Starts an asynchronous process to revert (undo) the check-out for a batch of versioned items. This action discards any changes made since the items were checked out and removes their locks.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the checked-out items to revert."),
        removePermanentLock: z.boolean().optional().default(true)
            .describe("Set to true to ensure the permanent lock is removed from each item."),
    },
    execute: async ({ itemIds, removePermanentLock }: { itemIds: string[]; removePermanentLock: boolean }) => {
        try {
            const requestModel = {
                Ids: itemIds,
                RemovePermanentLock: removePermanentLock
            };

            const response = await authenticatedAxios.post('/batch/undoCheckOut', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch undo check-out process started for ${itemIds.length} items.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch undo check-out");
        }
    }
};