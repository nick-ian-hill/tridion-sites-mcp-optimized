import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const checkOutItem = {
    name: "checkOutItem",
    description: `Checks out a versioned item (e.g., Component, Page, Schema, ComponentTemplate, or PageTemplate). The tools for updating items (e.g., 'updateContent' and 'updateItemProperties') automatically handle item check-out and check-in. You only need to use this tool if you want to prevent other users from editing it simultaneously. You can use the 'getItem' tool to inspect the 'LockInfo' property to see if an item is already checked out.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID (TCM URI) of the versioned item to check out. The version number should not be included."),
        setPermanentLock: z.boolean().optional().default(true).describe("Set to true to apply a permanent lock that requires an explicit check-in or undo check-out to release. Set to false for a temporary (session) lock."),
    },
    execute: async ({ itemId, setPermanentLock = true }: { itemId: string; setPermanentLock: boolean; },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const requestModel = {
                "$type": "CheckOutRequest",
                SetPermanentLock: setPermanentLock
            };
            
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/checkOut`, requestModel);

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully checked out item ${itemId}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to check out item ${itemId}`);
        }
    }
};