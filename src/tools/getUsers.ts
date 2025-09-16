import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getUsers = {
    name: "getUsers",
    description: "Gets a list of Users, with options to filter the results.",
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
            return handleAxiosError(error, "Failed to retrieve list of users");
        }
    }
};