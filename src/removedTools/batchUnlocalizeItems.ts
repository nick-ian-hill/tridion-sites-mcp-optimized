import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const batchUnlocalizeItems = {
    name: "batchUnlocalizeItems",
    description: `Starts an asynchronous process to unlocalize a batch of local items, re-establishing inheritance from their parent items. This is more efficient than unlocalizing items one by one using the 'unlocalizeItem' tool. The initial response includes a batch ID that can be used to monitor the status of the operation with the 'getBatchOperationStatus' tool.
To find items that are localized and can be unlocalized, use the 'search' tool with the 'BlueprintStatus' parameter set to 'Localized'.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/)).describe("An array of unique IDs (TCM URIs) for the local items to be unlocalized. Use the 'search' tool to find items with a 'BlueprintStatus' of 'Localized'."),
        confirmed: z.boolean().optional().describe("Confirmation to proceed with batch unlocalization, which will discard local changes."),
    },
    execute: async ({ itemIds, confirmed }: { itemIds: string[]; confirmed?: boolean },
        context: any
    ) => {
        if (!confirmed) {
            return {
                elicit: {
                    input: "confirmed",
                    content: [{
                        type: "text",
                        text: `Are you sure you want to unlocalize these ${itemIds.length} items? This action will discard all local changes and cannot be undone.`
                    }],
                }
            };
        }

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const requestModel = { ItemIds: itemIds };
            const response = await authenticatedAxios.post('/batch/unlocalize', requestModel);

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
            return handleAxiosError(error, "Failed to start batch unlocalization");
        }
    }
};