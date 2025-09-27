import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const batchClassificationInputProperties = {
    itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
        .min(1, "At least one item ID must be provided.")
        .describe("An array of unique IDs (TCM URIs) for the items to modify."),
    keywordIdsToAdd: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for Keywords to apply to the items."),
    keywordIdsToRemove: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
        .optional()
        .describe("An array of unique IDs (TCM URIs) for Keywords to remove from the items."),
};

const batchClassificationSchema = z.object(batchClassificationInputProperties);

export const batchClassification = {
    name: "batchClassification",
    description: `Starts an asynchronous process to classify, unclassify, or reclassify a batch of items. This single tool can add and/or remove specified keywords for all items in the batch, making it more efficient than individual operations. The initial response includes a batch ID for monitoring the process status.`,
    
    input: batchClassificationInputProperties,

    execute: async (
        input: z.infer<typeof batchClassificationSchema>,
        context: any
    ) => {
        const { itemIds, keywordIdsToAdd = [], keywordIdsToRemove = [] } = input;

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
            
            const requestModel = { 
                "$type": "BatchClassificationRequest",
                "ItemIds": itemIds, 
                "KeywordIdsToAdd": keywordIdsToAdd,
                "KeywordIdsToRemove": keywordIdsToRemove
            };

            const response = await authenticatedAxios.post('/batch/classification', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                let message = `Batch classification process started for ${itemIds.length} items.`;
                if (keywordIdsToAdd.length > 0) {
                    message += ` Adding ${keywordIdsToAdd.length} keyword(s).`;
                }
                if (keywordIdsToRemove.length > 0) {
                    message += ` Removing ${keywordIdsToRemove.length} keyword(s).`;
                }
                message += `\n\n${JSON.stringify(response.data, null, 2)}`;

                return {
                    content: [{
                        type: "text",
                        text: message
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