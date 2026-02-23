import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const batchCheckIn = {
    name: "batchCheckIn",
    description: `Starts an asynchronous process to check in a batch of versioned items. This saves the current changes for each item as a new version and removes the locks, making them available for other users to edit. This operation is more efficient than performing 'checkInItem' on each item separately. The initial response includes a batch ID that can be used to monitor the status of the operation with the 'getBatchOperationStatus' tool.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the versioned items to check in."),
        removePermanentLock: z.boolean().optional().default(true)
            .describe("Set to true to remove the permanent lock from each item after check-in."),
        userComment: z.string().optional()
            .describe("An optional comment to describe the changes made. This comment will be applied to all items in the batch."),
    },
    execute: async ({ itemIds, removePermanentLock = true, userComment }: { itemIds: string[]; removePermanentLock: boolean; userComment?: string },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const requestModel: { [key: string]: any } = {
                ItemIds: itemIds,
                RemovePermanentLock: removePermanentLock
            };

            if (userComment) {
                requestModel.UserComment = userComment;
            }

            const response = await authenticatedAxios.post('/batch/checkIn', requestModel);

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
            return handleAxiosError(error, "Failed to start batch check-in");
        }
    }
};