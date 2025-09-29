import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const getLockedItems = {
    name: "getLockedItems",
    description: "Gets a list of locked (e.g., checked-out) items. This is useful for administrative review or to understand the state of items before attempting (batch) operations. The 'LockUser' ID returned can be used as input for the 'search' tool to find all items locked by a specific user.",
    input: {
        forAllUsers: z.boolean().optional().default(false)
            .describe("If true, items locked by any user are returned. Requires Publication Administration or Lock Management rights. This parameter is ignored if 'lockUserId' is specified."),
        lockUserId: z.string().regex(/^tcm:0-\d+-65552$/).optional()
            .describe("The TCM URI of a specific user (e.g., 'tcm:0-1-65552'). If specified, only items locked by this user are returned."),
        lockFilter: z.array(z.enum([
            "None", "CheckedOut", "Permanent", "NewItem", "InWorkflow", "Reserved"
        ])).optional()
            .describe("A bitmask to apply to the items' lock type. Must be used in combination with 'lockResult'."),
        lockResult: z.array(z.enum([
            "None", "CheckedOut", "Permanent", "NewItem", "InWorkflow", "Reserved"
        ]))
            .describe("Constrains the returned items' lock type. Must be used in combination with 'lockFilter'."),
        maxResults: z.number().int().optional().default(500)
            .describe("Specifies the maximum number of results to return."),
    },
    execute: async ({ forAllUsers = false, lockUserId, lockFilter, lockResult, maxResults = 500 }: {
        forAllUsers?: boolean;
        lockUserId?: string;
        lockFilter?: Array<"None" | "CheckedOut" | "Permanent" | "NewItem" | "InWorkflow" | "Reserved">;
        lockResult?: Array<"None" | "CheckedOut" | "Permanent" | "NewItem" | "InWorkflow" | "Reserved">;
        maxResults?: number;
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const params = {
                forAllUsers,
                lockUserId,
                lockFilter,
                lockResult,
                maxResults,
            };

            const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined));

            const response = await authenticatedAxios.get('/lockedItems', {
                params: cleanParams
            });

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