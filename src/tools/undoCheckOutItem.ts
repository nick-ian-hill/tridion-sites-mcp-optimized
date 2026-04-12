import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const undoCheckOutItem = {
    name: "undoCheckOutItem",
    summary: "Discards changes and unlocks a previously checked-out item, reverting it to its last major version.",
    description: `Reverts (undoes) the check-out of a versioned item. Often referred to as revertItem.
    This action discards any changes made since the item was checked out and removes the lock, reverting it to its last major version.
    If the item does not have a major version, it will be removed (i.e., deleted) from the system.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/).describe("The unique ID (TCM URI) of the checked-out versioned item. The version number should not be included."),
        removePermanentLock: z.boolean().optional().default(true).describe("Set to true to ensure the permanent lock is removed. This should typically be true."),
    },
    execute: async ({ itemId, removePermanentLock = true }: { itemId: string; removePermanentLock: boolean }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const requestModel = {
                "$type": "UndoCheckOutRequest",
                RemovePermanentLock: removePermanentLock
            };

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/undoCheckOut`, requestModel);

            if (response.status === 200 || response.status === 204) {
                let responseData;
                if (response.data && response.data.Id && response.data['$type']) {
                    responseData = {
                        type: response.data['$type'],
                        Id: response.data.Id,
                        Message: `Successfully reverted ${response.data.Id}`
                    };
                } else {
                    responseData = {
                        type: 'Success',
                        Id: itemId,
                        Message: `Successfully reverted ${itemId}`
                    };
                }
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
            return handleAxiosError(error, `Failed to undo check-out for item ${itemId}`);
        }
    }
};