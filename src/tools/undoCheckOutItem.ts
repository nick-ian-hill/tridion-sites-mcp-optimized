import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const undoCheckOutItem = {
    name: "undoCheckOutItem",
    description: `Reverts (undoes) the check-out of a versioned item. Often referred to as revertItem. This action discards any changes made since the item was checked out and removes the lock, reverting it to its last major version.`,
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the checked-out versioned item. The version number should not be included."),
        removePermanentLock: z.boolean().optional().default(true).describe("Set to true to ensure the permanent lock is removed. This should typically be true."),
    },
    execute: async ({ itemId, removePermanentLock }: { itemId: string; removePermanentLock: boolean }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const requestModel = {
                "$type": "UndoCheckOutRequest",
                RemovePermanentLock: removePermanentLock
            };

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/undoCheckOut`, requestModel);

            // A successful undo check-out returns 200 (with item) or 204 (no content).
            if (response.status === 200 || response.status === 204) {
                const responseData = response.data ? `\n\n${JSON.stringify(response.data, null, 2)}` : " The operation returned no content.";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully reverted check-out for item ${itemId}.${responseData}`
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
                errors: [{ message: `Failed to undo check-out for item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};