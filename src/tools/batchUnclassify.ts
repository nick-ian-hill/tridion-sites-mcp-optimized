import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchUnclassify = {
    name: "batchUnclassify",
    description: `Starts an asynchronous process to unclassify a batch of items by removing specified keywords. For each item, the tool attempts to remove the specified keywords from any fields where they are currently set. This is more efficient than unclassifying items individually. The initial response includes a batch ID that can be used to monitor the status of the operation.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the items to be unclassified."),
        keywordIds: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/))
            .describe("An array of unique IDs (TCM URIs) for the Keywords to remove from the items."),
    },
    execute: async ({ itemIds, keywordIds }: { itemIds: string[], keywordIds: string[] }) => {
        try {
            // The API expects a request body with ItemIds and KeywordIds properties.
            const requestModel = { 
                ItemIds: itemIds, 
                KeywordIds: keywordIds 
            };
            const response = await authenticatedAxios.post('/batch/unclassify', requestModel);

            // A 202 status code indicates the batch process was accepted and started.
            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch unclassification process started for ${itemIds.length} items using ${keywordIds.length} keywords.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch unclassification");
        }
    }
};