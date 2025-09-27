import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const unlocalizeItem = {
    name: "unlocalizeItem",
    description: `Unlocalizes a localized item, discarding any local changes and returing the item to a copy of its parent.

This tool is only applicable to items that are localized (i.e., where BluePrintInfo.IsLocalized is true).
It will return an error if the item is a primary item (BluePrintInfo.IsShared: false and BluePrintInfo.IsLocalized: false).
The tool returns a confirmation that the item has been successfully unlocalized.
`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID (TCM URI) of the local item to unlocalize."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Loads the latest saved version of the item if available."),
    },
    execute: async ({ itemId, useDynamicVersion = true }: { itemId: string, useDynamicVersion: boolean }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/unlocalize`, null, {
                params: {
                    useDynamicVersion
                }
            });

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully unlocalized item ${itemId}.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to unlocalize item ${itemId}`);
        }
    }
};