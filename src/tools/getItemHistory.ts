import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getItemHistory = {
    name: "getItemHistory",
    description: "Gets all major versions of a specified versioned item, such as a Component, Page, or Schema.",
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
            .describe("The unique ID of the versioned item. The ID should not contain a version number (e.g., 'tcm:5-256-8')."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            // The API requires the colon in the TCM URI to be replaced with an underscore for the path parameter.
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/history`;

            // Make the GET request to the history endpoint.
            const response = await authenticatedAxios.get(endpoint);

            // A successful request will return a 200 OK status.
            if (response.status === 200) {
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
            return handleAxiosError(error, `Failed to retrieve history for item '${itemId}'`);
        }
    }
};