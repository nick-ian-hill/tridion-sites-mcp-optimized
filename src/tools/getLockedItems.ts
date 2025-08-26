import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const lockTypeEnum = z.enum([
    "None",
    "CheckedOut",
    "Permanent",
    "NewItem",
    "InWorkflow",
    "Reserved"
]);

export const getLockedItems = {
    name: "getLockedItems",
    description: "Gets a list of locked items. By default, it returns items locked by the current user, but can be filtered by user and lock type.",
    input: {
        forAllUsers: z.boolean().optional().default(false)
            .describe("If true, items locked by any user are returned. Requires Publication Administration or Lock Management rights. This parameter is ignored if 'lockUserId' is specified."),
        lockUserId: z.string().regex(/^tcm:0-\d+-65552$/).optional()
            .describe("The TCM URI of a specific user (e.g., 'tcm:0-1-65552'). If specified, only items locked by this user are returned."),
        lockFilter: z.array(lockTypeEnum).optional()
            .describe("A bitmask to apply to the items' lock type. Must be used in combination with 'lockResult'."),
        lockResult: z.array(lockTypeEnum).optional()
            .describe("Constrains the returned items' lock type. Must be used in combination with 'lockFilter'."),
        maxResults: z.number().int().optional().default(500)
            .describe("Specifies the maximum number of results to return."),
    },
    execute: async ({ forAllUsers, lockUserId, lockFilter, lockResult, maxResults }: {
        forAllUsers?: boolean;
        lockUserId?: string;
        lockFilter?: Array<"None" | "CheckedOut" | "Permanent" | "NewItem" | "InWorkflow" | "Reserved">;
        lockResult?: Array<"None" | "CheckedOut" | "Permanent" | "NewItem" | "InWorkflow" | "Reserved">;
        maxResults?: number;
    }) => {
        try {
            // Assemble the query parameters for the API request.
            const params = {
                forAllUsers,
                lockUserId,
                lockFilter,
                lockResult,
                maxResults,
            };

            // Remove any parameters that are undefined, so they are not sent in the request.
            const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined));

            // Make the GET request to the lockedItems endpoint.
            const response = await authenticatedAxios.get('/lockedItems', {
                params: cleanParams
            });

            // A successful request will return a 200 OK status.
            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve locked items");
        }
    }
};