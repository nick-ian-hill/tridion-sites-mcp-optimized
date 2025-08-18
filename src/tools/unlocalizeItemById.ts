import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const unlocalizeItemById = {
    name: "unlocalizeItemById",
    description: `Unlocalizes a local item, effectively deleting the local copy and re-establishing the inheritance from its primary item. The tool returns the shared parent item that is now being inherited.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID (TCM URI) of the local item to unlocalize."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Loads the latest saved version of the item if available."),
    },
    execute: async ({ itemId, useDynamicVersion }: { itemId: string, useDynamicVersion: boolean }) => {
        try {
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