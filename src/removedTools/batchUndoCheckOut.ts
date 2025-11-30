import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const batchUndoCheckOut = {
    name: "batchUndoCheckOut",
    description: `Starts an asynchronous process to revert (undo) the check-out for a batch of versioned items. This action discards any changes made since the items were checked out and removes their locks. This is more efficient than performing 'undoCheckOutItem' on items individually. The initial response includes a batch ID that can be used to monitor the status of the operation with the 'getBatchOperationStatus' tool.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the checked-out items to revert."),
        removePermanentLock: z.boolean().optional().default(true)
            .describe("Set to true to ensure the permanent lock is removed from each item."),
    },
    execute: async ({ itemIds, removePermanentLock = true }: { itemIds: string[]; removePermanentLock: boolean },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const requestModel = {
                ItemIds: itemIds,
                RemovePermanentLock: removePermanentLock
            };

            const response = await authenticatedAxios.post('/batch/undoCheckOut', requestModel);

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
            return handleAxiosError(error, "Failed to start batch undo check-out");
        }
    }
};