import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const unlocalizeItemById = {
    name: "unlocalizeItemById",
    description: `Unlocalizes a local item, effectively deleting the local copy and re-establishing the inheritance from its primary item. The tool returns the shared parent item that is now being inherited.`,
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the local item to unlocalize."),
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

            // A successful unlocalization returns a 200 status code.
            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully unlocalized item ${itemId}.\n\n${JSON.stringify(response.data, null, 2)}`
                        }
                    ],
                };
            } else {
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status: ${response.status}` },
                    ],
                };
            }
        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to unlocalize item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};