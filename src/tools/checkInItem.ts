import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const checkInItem = {
    name: "checkInItem",
    description: `Checks in a versioned item that was previously checked out. This action saves the changes as a new version of the item and removes the lock, making it available for other users to edit.`,
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the versioned item to check in. The version number should not be included."),
        removePermanentLock: z.boolean().optional().default(true).describe("Set to true to remove the permanent lock after check-in. If false, the item remains locked."),
        userComment: z.string().optional().describe("An optional comment to describe the changes made in this version."),
    },
    execute: async ({ itemId, removePermanentLock, userComment }: { itemId: string; removePermanentLock: boolean; userComment?: string }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const requestModel: { [key: string]: any } = {
                "$type": "CheckInRequest",
                RemovePermanentLock: removePermanentLock
            };

            if (userComment) {
                requestModel.UserComment = userComment;
            }

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/checkIn`, requestModel);

            // A successful check-in returns a 200 status code with the newly versioned item.
            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully checked in item ${itemId}.\n\n${JSON.stringify(response.data, null, 2)}`
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
                errors: [{ message: `Failed to check in item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};