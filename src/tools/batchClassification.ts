import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

const batchClassificationInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
        .min(1, "At least one item ID must be provided.")
        .describe("An array of unique IDs (TCM URIs) for the items to modify. Use 'search' or 'getItemsInContainer' to find items."),
    keywordIdsToAdd: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for Keywords to apply to the items. Use 'getCategories' and 'getKeywordsForCategory' to find available keywords."),
    keywordIdsToRemove: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for Keywords to remove from the items. Use 'bulkReadItems' in combination with the 'includeProperties' property (or set the 'loadFullItems' property to true) to find the currently used keywords for each item."),
};

const batchClassificationSchema = z.object(batchClassificationInputProperties);

export const batchClassification = {
    name: "batchClassification",
    description: `Starts an asynchronous process to classify, unclassify, or reclassify a batch of items. This single tool can add and/or remove specified keywords for all items in the batch. The initial response includes a batch ID for monitoring the process status with the 'getBatchOperationStatus' tool.

  Important: - Adding a Keyword is only possible if an item's Schema contains one or more 'KeywordFieldDefinition' fields that reference the Category the Keyword belongs to. 
- Any Keywords to add/remove for which there is no matching Keyword field will be ignored for that item.
- If a Keyword to be added is already present in all relevant fields for an item, it will be ignored for that item.
- If a Keyword to be removed is not present in any relevant field for an item, it will be ignored for that item.`,
    
    input: batchClassificationInputProperties,

    execute: async (
        input: z.infer<typeof batchClassificationSchema>,
        context: any
    ) => {
        const { itemIds, keywordIdsToAdd = [], keywordIdsToRemove = [] } = input;

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

            // Map keywords to the publication context of the first item in the batch
            const contextItemId = itemIds[0];
            const finalKeywordIdsToAdd = keywordIdsToAdd.map(keywordId =>
                convertItemIdToContextPublication(keywordId, contextItemId)
            );
            const finalKeywordIdsToRemove = keywordIdsToRemove.map(keywordId =>
                convertItemIdToContextPublication(keywordId, contextItemId)
            );
            
            const requestModel = { 
                "$type": "BatchClassificationRequest",
                "ItemIds": itemIds, 
                "KeywordIdsToAdd": finalKeywordIdsToAdd,
                "KeywordIdsToRemove": finalKeywordIdsToRemove
            };

            const response = await authenticatedAxios.post('/batch/classification', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
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
            return handleAxiosError(error, "Failed to start batch classification process");
        }
    }
};