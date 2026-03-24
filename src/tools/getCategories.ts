import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getCategories = {
    name: "getCategories",
    description: `Retrieves the list of categories for a specified publication (Id, Title, Type).
    
    This is the first step in finding available keywords. After getting a category's ID from this tool, use 'getItemsInContainer' or 'getClassificationKeywordsForCategory' to see the keywords within it.

    A category represents a set of keywords, possibly hierarchically structured.
    Keyword hierarchies arise when one or more keywords has one or more parent keywords.
    Parent keywords are defined in the child keyword.
    Parent keywords must belong to the same category as the child keyword.
    Circular references are not permitted.
    
    ### "Find-Then-Fetch" Pattern
    This tool only returns Id, Title, and type.minimal identification data.
    
    To inspect specific details of a Category:
    1.  **Find:** Use this tool to get the Category ID.
    2.  **Fetch:** Use the 'toolOrchestrator' to call 'getItem' on the Category ID.`,
    input: {
        itemId: z.string().regex(/^tcm:0-[1-9]\d*-1$/).describe("The unique ID of a Publication (e.g., 'tcm:0-5-1'). Use 'getPublications' to find a Publication ID."),
    },
    execute: async ({ itemId }: { itemId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/categories`;
            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    details: "IdAndTitle" 
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
            return handleAxiosError(error, `Failed to retrieve categories for publication '${itemId}'`);
        }
    }
};