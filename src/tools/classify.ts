import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

const classifyInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
        .describe("The unique ID (TCM URI) of the item to modify."),
    keywordIdsToAdd: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for Keywords to apply to the item. To find available keywords, first use 'getCategories' to get a list of categories, then use 'getKeywordsForCategory' to list the keywords within a category."),
    keywordIdsToRemove: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for Keywords to remove from the item."),
};

const classifySchema = z.object(classifyInputProperties);

export const classify = {
    name: "classify",
    description: "Classifies, unclassifies, or reclassifies a single item by adding and/or removing specified keywords. This is a synchronous operation. For batch operations, use the 'batchClassification' tool.",
    
    input: classifyInputProperties,

    execute: async (
        input: z.infer<typeof classifySchema>,
        context: any
    ) => {
        const { itemId, keywordIdsToAdd = [], keywordIdsToRemove = [] } = input;

        if (keywordIdsToAdd.length === 0 && keywordIdsToRemove.length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "Validation Error: You must provide at least one keyword to add or remove."
                }]
            };
        }

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // The request body for the single-item classification endpoint.
            const requestModel = { 
                "$type": "ClassificationRequest",
                "KeywordIdsToAdd": keywordIdsToAdd,
                "KeywordIdsToRemove": keywordIdsToRemove
            };

            // Escape the colon in the item ID for the URL path as per the spec.
            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/classify`, requestModel);

            // A 200 status code indicates the operation was successful.
            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully updated classification for item ${itemId}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to update classification for item ${itemId}`);
        }
    }
};