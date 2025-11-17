import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getClassifiedItemsInputProperties = {
    keywordId: z.string().regex(/^(tcm:\d+-\d+-1024?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI of the Keyword to search for. To find a keyword, first use 'getCategories' to find a Category, then 'getKeywordsForCategory' to list its keywords."),
    useDynamicVersion: z.boolean().optional().default(false).describe("If true, loads the latest saved version (dynamic version) for any versioned items returned."),
    itemTypes: z.array(z.string()).optional().describe("An array of item types to filter the results, e.g., ['Component', 'Page', 'Folder']. If omitted, all item types are returned."),
    resolveDescendantKeywords: z.boolean().optional().default(false).describe("If true, items classified with descendant keywords of the specified keyword are also included in the results."),
    resultLimit: z.number().int().optional().default(100).describe("The maximum number of items to return. Specify a positive value, or -1 for no limit. Defaults to 100."),
};

const getClassifiedItemsSchema = z.object(getClassifiedItemsInputProperties);

export const getClassifiedItems = {
    name: "getClassifiedItems",
    description: `Gets a list of all items that are classified with a specified Keyword. 'Classified' means an item has a keyword field that contains the specified Keyword.
    Note that this tool does NOT return properties like  'Content', 'Metadata' (values), or 'BinaryContent' (MimeType, Size). To inspect those properties, you must use 'getItem' or 'bulkReadItems' on the returned IDs.

  Strategy for tasks requiring post-processing or aggregation of results (e.g., "Find the Most...", "Count all...")
  When post-processing of data from a large set of items is required, do not use this tool directly.
  This approach is token-inefficient and will fail on large result sets. The correct, scalable method is to use the 'toolOrchestrator', and supply a postProcessingScript to perform the aggregation on the server-side. See the 'toolOrchestrator' documentation for the recommended 3-phase (setup-map-reduce) pattern.
`,

    input: getClassifiedItemsInputProperties,

    execute: async (input: z.infer<typeof getClassifiedItemsSchema>, context: any) => {
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
                const formattedResponseData = formatForAgent(response.data);
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
    }
};