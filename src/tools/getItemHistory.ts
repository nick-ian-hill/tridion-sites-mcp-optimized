import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getItemHistory = {
    name: "getItemHistory",
    summary: "Lists all major versions of a versioned item to find a specific version ID for rollback.",
    description: "Gets all major versions of a specified versioned item. The primary use of this tool is to find the version-specific URI of an older version before using the 'rollbackItem' tool to revert to it.",
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/)
            .describe("The unique ID of the versioned item. The ID should not contain a version number (e.g., 'tcm:5-256-8')."),
    },
    execute: async ({ itemId }: { itemId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/history`;

            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    includeProperties: ["VersionInfo"] 
                });

                const formattedResponseData = formatForAgent(finalData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve history for item '${itemId}'`);
        }
    }
};