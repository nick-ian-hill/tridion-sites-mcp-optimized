import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getClassificationKeywordsForCategory = {
    name: "getClassificationKeywordsForCategory",
    description: `Retrieves a list of all non-abstract keywords for the specified category.
    
    This tool is specifically designed to find keywords that can be used to tag/classify content. It automatically filters out 'Abstract' keywords (which are used purely for hierarchical navigation).
    
    The keyword IDs returned by this tool are used as input for tools like 'classify' and 'getItemsClassifiedByKeyword'.

    Note that Keywords can be associated with items via 'keyword' fields in an item's content or metadata.
    
    NOTE: If you need to view the entire taxonomy tree (including Abstract parent keywords) or need to see hierarchical relationships, use the 'getItemsInContainer' tool instead.
    
    ### "Find-Then-Fetch" Pattern
    This tool returns ONLY minimal identification data (Id, Title, type). To inspect other properties, use the 'getItem' tool.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/).describe("The unique ID of the category (e.g., 'tcm:5-123-512'). Use 'getCategories' to find a Category ID."),
    },
    execute: async ({ itemId }: { itemId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/keywords`;
            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    details: "IdAndTitle" 
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
            return handleAxiosError(error, `Failed to retrieve keywords for item '${itemId}'`);
        }
    }
};