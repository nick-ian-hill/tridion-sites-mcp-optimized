import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

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
        confirmed: z.boolean().optional().describe("Confirmation to proceed with unlocalizing the item, which will discard local changes."),
    },
    execute: async ({ itemId, useDynamicVersion = true, confirmed }: { itemId: string; useDynamicVersion: boolean; confirmed?: boolean }, context: any) => {
        if (!confirmed) {
            return {
                elicit: {
                    input: "confirmed",
                    content: [{
                        type: "text",
                        text: `Are you sure you want to unlocalize the item ${itemId}? This action will discard all local changes and cannot be undone.`
                    }],
                }
            };
        }

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
                        text: `Successfully unlocalized item ${itemId}`
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