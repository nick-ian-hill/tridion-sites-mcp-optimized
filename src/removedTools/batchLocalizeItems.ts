import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const batchLocalizeItems = {
    name: "batchLocalizeItems",
    description: `Starts an asynchronous process to localize a batch of shared items, creating local copies that can be edited. This is more efficient than localizing items one by one using the 'localizeItem' tool. The initial response includes a batch ID that can be used to monitor the status of the operation with the 'getBatchOperationStatus' tool.
To find items that are shared and can be localized, use the 'search' tool with the 'BlueprintStatus' parameter set to 'Shared'.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).describe("An array of unique IDs (TCM URIs) for the shared items to be localized. Use the 'search' tool to find items with a 'BlueprintStatus' of 'Shared'."),
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
            const response = await authenticatedAxios.post('/batch/localize', requestModel);

            if (response.status === 202) {
                const formattedResponse = formatForAgent(response.data);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponse, null, 2)
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