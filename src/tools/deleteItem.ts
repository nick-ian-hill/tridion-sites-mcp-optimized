import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const deleteItem = {
    name: "deleteItem",
    description: `Permanently deletes an item from the Content Manager. You can delete all versions of an item by providing its base URI, or delete a specific version by including the version number in the URI. The operation may fail if the item is currently used by other items in the system.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?(-v\d+)?$/).describe("The unique ID (TCM URI) of the item to delete. To delete a specific version, include the version number in the URI (e.g., 'tcm:5-263-64-v3')."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            // The item ID for delete can contain a version (e.g., tcm:5-263-64-v3), so we replace ':' with '_'
            const escapedItemId = itemId.replace(':', '_');
            
            const response = await authenticatedAxios.delete(`/items/${escapedItemId}`);

            // A successful deletion returns a 204 status code.
            if (response.status === 204) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully deleted item ${itemId}.`
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
                errors: [{ message: `Failed to delete item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};