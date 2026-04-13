import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

const getItemsClassifiedByKeywordInputProperties = {
    keywordId: z.string().regex(/^(tcm:\d+-\d+-1024?|ecl:[^:\s]+)$/).describe("The TCM URI of the Keyword to search for. To find a keyword, first use 'getCategories' to find a Category, then 'getClassificationKeywordsForCategory' to list applicable keywords."),
    useDynamicVersion: z.boolean().optional().default(false).describe("If true, loads the latest saved version (dynamic version) for any versioned items returned."),
    itemTypes: z.array(z.string()).optional().describe("An array of item types to filter the results, e.g., ['Component', 'Page', 'Folder']. If omitted, all item types are returned."),
    resolveDescendantKeywords: z.boolean().optional().default(false).describe("If true, items classified with descendant keywords of the specified keyword are also included in the results."),
    resultLimit: z.number().int().optional().default(100).describe("The maximum number of items to return. Specify a positive value, or -1 for no limit. Defaults to 100."),
};
const getItemsClassifiedByKeywordSchema = z.object(getItemsClassifiedByKeywordInputProperties);

export const getItemsClassifiedByKeyword = {
    name: "getItemsClassifiedByKeyword",
    summary: "Finds all items tagged with a specific Keyword. Useful for taxonomy-based content discovery.",
    description: `Gets a list of all items that are classified with a specified Keyword.
'Classified' means an item has a keyword field that contains the specified Keyword.

### "Find-Then-Fetch" Pattern
This tool returns **ONLY** the 'Id', 'Title', and 'type' of matching items.
To inspect item details:
1.  **Find:** Use this tool to get the list of item IDs.
2.  **Fetch:** Pass the IDs to the 'bulkReadItems' tool, or iterate over the items using the 'toolOrchestrator' and call 'getItem'.
    To retrieve specific properties (e.g., 'Content', 'Metadata', etc.) use the includeProperties parameter in the 'getItem' or 'bulkReadItems' tools.`,

    input: getItemsClassifiedByKeywordInputProperties,

    execute: async (input: z.infer<typeof getItemsClassifiedByKeywordSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;
        const { keywordId, useDynamicVersion = false, itemTypes, resolveDescendantKeywords = false, resultLimit = 100 } = input;
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedKeywordId = keywordId.replace(':', '_');
            const endpoint = `/items/${escapedKeywordId}/classifiedItems`;

            const response = await authenticatedAxios.get(endpoint, {
                params: {
                    useDynamicVersion: useDynamicVersion,
                    rloItemTypes: itemTypes,
                    resolveDescendantKeywords: resolveDescendantKeywords,
                    resultLimit: resultLimit,
                }
            });
            if (response.status === 200) {
                // The API returns full item details, so we must filter client-side to enforce the pattern.
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
            return handleAxiosError(error, `Failed to retrieve items classified by keyword '${keywordId}'`);
        }
    },
    examples: [
    ]
};