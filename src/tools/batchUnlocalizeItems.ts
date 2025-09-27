import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const batchUnlocalizeItems = {
    name: "batchUnlocalizeItems",
    description: `Starts an asynchronous process to unlocalize a batch of local items, re-establishing inheritance from their parent items. This is more efficient than unlocalizing items one by one. The initial response includes a batch ID that can be used to monitor the status of the operation.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).describe("An array of unique IDs (TCM URIs) for the local items to be unlocalized."),
    },
    execute: async ({ itemIds }: { itemIds: string[] },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const requestModel = { ItemIds: itemIds };
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