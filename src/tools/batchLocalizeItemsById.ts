import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchLocalizeItemsById = {
    name: "batchLocalizeItemsById",
    description: `Starts an asynchronous process to localize a batch of shared items, creating local copies that can be edited. This is more efficient than localizing items one by one. The initial response includes a batch ID that can be used to monitor the status of the operation.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).describe("An array of unique IDs (TCM URIs) for the shared items to be localized."),
    },
    execute: async ({ itemIds }: { itemIds: string[] }) => {
        try {
            const requestModel = { Ids: itemIds };
            const response = await authenticatedAxios.post('/batch/localize', requestModel);

            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch localization process started for ${itemIds.length} items.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch localization");
        }
    }
};