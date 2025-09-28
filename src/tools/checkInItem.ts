import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const checkInItem = {
    name: "checkInItem",
    description: `Checks in a versioned item that was previously checked out. This action saves the changes as a new version of the item and removes the lock, making it available for other users to edit.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID (TCM URI) of the versioned item to check in. The version number should not be included."),
        removePermanentLock: z.boolean().optional().default(true).describe("Set to true to remove the permanent lock after check-in. If false, the item remains locked."),
        userComment: z.string().optional().describe("An optional comment to describe the changes made in this version."),
    },
    execute: async ({ itemId, removePermanentLock = true, userComment }: { itemId: string; removePermanentLock: boolean; userComment?: string },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const requestModel: { [key: string]: any } = {
                "$type": "CheckInRequest",
                RemovePermanentLock: removePermanentLock
            };

            if (userComment) {
                requestModel.UserComment = userComment;
            }

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/checkIn`, requestModel);

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully checked in item ${itemId}.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to check in item ${itemId}`);
        }
    }
};