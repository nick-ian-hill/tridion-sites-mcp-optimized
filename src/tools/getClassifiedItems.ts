import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

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
    description: `Gets a list of all items that are classified with a specified Keyword. 'Classified' means an item has a keyword field that contains the specified Keyword. This tool is useful for finding all content related to a specific tag or category.`,

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
            return handleAxiosError(error, `Failed to retrieve items classified by keyword '${keywordId}'`);
        }
    }
};