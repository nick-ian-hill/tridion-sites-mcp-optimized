import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getLockedItems = {
    name: "getLockedItems",
    description: `Gets a list of new and locked items, e.g., versioned items that have never/not yet been checked in, checked-out items, items in workflow, etc.
    This tool is useful for administrative review and for verifying the state of items before attempting (batch) operations.
    Where possible, use the includeProperties parameter to limit the response to the properties of interest.

Example:

Finds all items locked by the current user and returns only their location path and full lock information.

    const result = await tools.getLockedItems({
        includeProperties: ["LocationInfo.Path", "LockInfo"]
    });

Expected JSON Output for a single item in the result array:
[
  {
    "Id": "tcm:1-123-64",
    "Title": "My Locked Page",
    "$type": "Page",
    "LocationInfo": {
      "Path": "\\web\\root\\subfolder"
    },
    "LockInfo": {
      "LockType": ["CheckedOut"],
      "LockDate": "2025-10-03T10:16:53.11Z",
      "LockUser": {
        "$type": "Link",
        "IdRef": "tcm:0-9-65552",
        "Title": "LDAP\\ADesigner",
        "Description": "A Designer"
      }
    }
  }
]`,
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
        includeProperties: z.array(z.string()).optional().describe(`An array of property names to include in the response, reducing the amount of data returned. 'Id', 'Title', and '$type' are always included.
Use dot notation for nested properties (e.g., "VersionInfo.Creator", "LockInfo.LockUser", "LocationInfo.Path"). This is useful for focusing on specific details without retrieving the full item data.`),
    },
    execute: async ({ forAllUsers = false, lockUserId, lockFilter, lockResult, maxResults = 500, includeProperties }: {
        forAllUsers?: boolean;
        lockUserId?: string;
        lockFilter?: Array<"None" | "CheckedOut" | "Permanent" | "NewItem" | "InWorkflow" | "Reserved">;
        lockResult?: Array<"None" | "CheckedOut" | "Permanent" | "NewItem" | "InWorkflow" | "Reserved">;
        maxResults?: number;
        includeProperties?: string[];
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
                const finalData = filterResponseData({ responseData: response.data, includeProperties });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(finalData, null, 2)
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