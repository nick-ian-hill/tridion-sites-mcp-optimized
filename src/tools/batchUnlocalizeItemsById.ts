import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchUnlocalizeItemsById = {
    name: "batchUnlocalizeItemsById",
    description: `Starts an asynchronous process to unlocalize a batch of local items. This effectively deletes the local copies and re-establishes the inheritance from their primary parent items in the BluePrint.
    This batch tool is more efficient than unlocalizing items one by one and returns a confirmation that the process has been accepted and is running in the background.
    You can load the batch process referenced in the repsonse to check the status of the process.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).describe("An array of unique IDs (TCM URIs) for the local items to be unlocalized."),
    },
    execute: async ({ itemIds }: { itemIds: string[] }) => {
        try {
            const requestModel = { Ids: itemIds };
            const response = await authenticatedAxios.post('/batch/unlocalize', requestModel);

            if (response.status === 202) {
                return {
                    content: [{
                        type: "text",
                        text: `Batch unlocalization process started for ${itemIds.length} items.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to start batch unlocalization");
        }
    }
};