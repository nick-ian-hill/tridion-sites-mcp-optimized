import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const checkOutItem = {
    name: "checkOutItem",
    description: `Checks out a versioned item to create a new, editable version. This action locks the item for the current user, preventing other users from editing it simultaneously. To save changes, the item must be updated and then checked in.`,
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the versioned item to check out. The version number should not be included."),
        setPermanentLock: z.boolean().optional().default(true).describe("Set to true to apply a permanent lock that requires an explicit check-in or undo check-out to release. Set to false for a temporary (session) lock."),
    },
    execute: async ({ itemId, setPermanentLock }: { itemId: string; setPermanentLock: boolean; }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const requestModel = {
                "$type": "CheckOutRequest",
                SetPermanentLock: setPermanentLock
            };
            
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/checkOut`, requestModel);

            // A successful checkout returns a 200 status code with the checked-out item.
            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully checked out item ${itemId}.\n\n${JSON.stringify(response.data, null, 2)}`
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
                errors: [{ message: `Failed to check out item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};