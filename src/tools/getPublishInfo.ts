import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getPublishInfoInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/)
        .describe("The unique ID (TCM URI) of the item to check."),
    includeProperties: z.array(z.string()).optional()
        .describe(`An array of property names to include in the response. 
IMPORTANT: To avoid fetching large, unnecessary data (like User and TargetType details), always use this to specify only the properties you need (e.g., ["PublishedAt"]). 
Use dot notation for nested properties (e.g., "TargetType.IdRef", "TargetType.Title", "User.Description"). 
'type' will always be included. Refer to the 'getItem' tool description for a comprehensive list of available properties.`),
};

const getPublishInfoSchema = z.object(getPublishInfoInputProperties);

export const getPublishInfo = {
    name: "getPublishInfo",
    description: `Retrieves a list of publish states for a specified item, showing when, where (to which Target Type), and by whom it was last published. This shows the current state, not the history of all publish actions.
    When asked to retrieve publish information for a large set of items, it's recommended that this tool is called via the 'toolOrchestrator'.
    In such cases, only request the information needed, and consider using a post processing script to limit the amount of returned data.`,

    input: getPublishInfoInputProperties,

    execute: async (input: z.infer<typeof getPublishInfoSchema>, context: any) => {
        const { itemId, includeProperties } = input;

        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/publishedTo`;

            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    includeProperties 
                });

                const formattedFinalData = formatForAgent(finalData);

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedFinalData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve publish info for item ${itemId}`);
        }
    }
};