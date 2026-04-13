import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getUsers = {
    name: "getUsers",
    summary: "Lists Users in the system with optional filtering. Useful for finding authors or owners.",
    description: `Gets a list of Users, with options to filter the results. The user IDs returned by this tool can be used as input for other tools, such as the 'lockUserId' parameter in 'getLockedItems' or the 'Author' and 'LockUser' parameters in the 'search' tool.`,
    input: {
        predefined: z.boolean().optional()
            .describe("If specified, return only non-predefined users (false) or predefined users (true). If omitted, both are returned."),
        includeDisabled: z.boolean().optional().default(false)
            .describe("Specifies whether to include disabled users. Defaults to false."),
        search: z.string().optional()
            .describe("If specified, return only users whose account name (Title) matches this value."),
        searchMode: z.enum(["Contains", "StartsWith", "EndsWith", "ExactMatch"]).optional().default("Contains")
            .describe("Specifies how to match the account name when using the 'search' parameter."),
    },
    execute: async ({ predefined, includeDisabled = false, search, searchMode = "Contains" }: {
        predefined?: boolean,
        includeDisabled?: boolean,
        search?: string,
        searchMode?: "Contains" | "StartsWith" | "EndsWith" | "ExactMatch"
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const response = await authenticatedAxios.get('/users', {
                params: {
                    predefined,
                    includeDisabled,
                    search,
                    searchMode,
                }
            });

            if (response.status === 200) {
                const propertiesToInclude = ['Description'];

                if (predefined === undefined) {
                    propertiesToInclude.push('IsPredefined');
                }

                if (includeDisabled === true) {
                    propertiesToInclude.push('IsEnabled');
                }

                const finalData = filterResponseData({
                    responseData: response.data,
                    includeProperties: propertiesToInclude
                });

                const formattedFinalData = formatForAgent(finalData);

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedFinalData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve list of users");
        }
    },
    examples: [
    ]
};