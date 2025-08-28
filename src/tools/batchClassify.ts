import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchClassify = {
    name: "batchClassify",
    description: `Starts an asynchronous process to classify a batch of items with a set of keywords. For each item, the tool attempts to apply the specified keywords to any matching keyword fields within that item. This is more efficient than classifying items individually. The initial response includes a batch ID that can be used to monitor the status of the operation.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the items to be classified."),
        keywordIds: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the Keywords to apply to the items."),
    },
    execute: async ({ itemIds, keywordIds }: { itemIds: string[], keywordIds: string[] }) => {
        try {
            // The API expects a request body with ItemIds and KeywordIds properties.
            const requestModel = { 
                ItemIds: itemIds, 
                KeywordIds: keywordIds 
            };
            const response = await authenticatedAxios.post('/batch/classify', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch classification process started for ${itemIds.length} items with ${keywordIds.length} keywords.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch classification");
        }
    }
};