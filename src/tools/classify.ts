import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

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
    description: `Classifies, unclassifies, or reclassifies a single item by adding and/or removing specified keywords. This is a synchronous operation. 
    
  Important:
- Adding a Keyword is only possible if the item's Schema (in the fields or metadataFields property) contains one or more KeywordFieldDefinition fields that link to the Keyword's parent Category. If you receive a Warning: "No changes were made...", it almost always means the Component's Schema is missing a 'KeywordFieldDefinition' for that Category. You must use updateItemProperties to add one.
- Any Keywords to add/remove for which there is no matching Keyword field will be ignored.
- If a Keyword to be added is already present in all relevant fields, it will be ignored.
- If a Keyword to be removed is not present in any relevant field, it will be ignored.

The tool will return a warning if no changes were made. For batch operations, use the 'batchClassification' tool.`,
    
    input: classifyInputProperties,

    execute: async (
        input: z.infer<typeof classifySchema>,
        context: any
    ) => {
        const { itemId, keywordIdsToAdd = [], keywordIdsToRemove = [] } = input;

        if (keywordIdsToAdd.length === 0 && keywordIdsToRemove.length === 0) {
            const errorResponse = {
                $type: 'Error',
                Message: "Validation Error: You must provide at least one keyword to add or remove."
            };
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(errorResponse, null, 2)
                }]
            };
        }

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            // Map keywords to the publication context of the target item
            const finalKeywordIdsToAdd = keywordIdsToAdd.map(keywordId =>
                convertItemIdToContextPublication(keywordId, itemId)
            );
            const finalKeywordIdsToRemove = keywordIdsToRemove.map(keywordId =>
                convertItemIdToContextPublication(keywordId, itemId)
            );
            
            // The request body for the single-item classification endpoint.
            const requestModel = { 
                "$type": "ClassificationRequest",
                "KeywordIdsToAdd": finalKeywordIdsToAdd,
                "KeywordIdsToRemove": finalKeywordIdsToRemove
            };

            // Escape the colon in the item ID for the URL path as per the spec.
            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/classify`, requestModel);

            // A 200 status code indicates the operation was successful.
            if (response.status === 200) {
                // Check if the API response indicates that changes were actually made
                if (response.data && response.data.Details && response.data.Details.length > 0 && response.data.Item) {
                    // Changes were made, return success
                    const responseData = {
                        $type: response.data.Item['$type'],
                        Id: response.data.Item.Id,
                        Message:`Successfully classified ${response.data.Item.Id}`
                    };
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(responseData, null, 2)
                        }],
                    };
                } else if (response.data && response.data.Item) {
                    // No changes were made, return a warning
                    const warningResponse = {
                        $type: response.data.Item['$type'],
                        Id: response.data.Item.Id,
                        Message: `Warning: No changes were made to item ${response.data.Item.Id}. The keywords may already be applied/removed or may not be applicable to the item's schema.`
                    };
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(warningResponse, null, 2)
                        }],
                    };
                } else {
                    // Fallback for unexpected 200 response structure
                    return handleUnexpectedResponse(response);
                }
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to update classification for item ${itemId}`);
        }
    }
};