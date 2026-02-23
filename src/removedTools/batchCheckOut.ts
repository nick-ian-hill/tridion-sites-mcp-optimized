import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const batchCheckOut = {
    name: "batchCheckOut",
    description: `Starts an asynchronous process to check out a batch of versioned items, making the items editable. This action locks each item for the current user, preventing others from editing them. The initial response includes a batch ID that can be used to monitor the status of the operation with the 'getBatchOperationStatus' tool.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the versioned items to check out."),
        setPermanentLock: z.boolean().optional().default(true)
            .describe("Set to true to apply a permanent lock to each item that requires an explicit check-in or undo check-out to release."),
    },
    execute: async ({ itemIds, setPermanentLock = true }: { itemIds: string[]; setPermanentLock: boolean; },
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
                SetPermanentLock: setPermanentLock
            };
            
            const response = await authenticatedAxios.post('/batch/checkOut', requestModel);

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
            return handleAxiosError(error, "Failed to start batch check-out");
        }
    }
};