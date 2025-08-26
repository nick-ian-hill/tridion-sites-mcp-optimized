import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const rollbackItem = {
    name: "rollbackItem",
    description: "Rolls back an item to a specific prior version. This action creates a new major version of the item with the content and metadata from the specified older version.",
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?-v\d+$/)
            .describe("The unique ID of the item, including the specific version to roll back to (e.g., 'tcm:1-2-8-v5')."),
        comment: z.string().optional()
            .describe("An optional comment or reason for the rollback. This will be stored in the new version's history."),
    },
    execute: async ({ itemId, comment }: { itemId: string, comment?: string }) => {
        try {
            // The API requires the colon in the TCM URI to be replaced with an underscore for the path parameter.
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/rollback`;

            // The API requires a 'RollBackRequest' model in the body.
            // We'll construct a payload, using the provided comment for the 'InstructionalText' field.
            const payload = {
                "$type": "RollBackRequest",
                "InstructionalText": comment
            };

            // Filter out InstructionalText if no comment is provided to send a clean payload.
            const cleanPayload = Object.fromEntries(
                Object.entries(payload).filter(([_, value]) => value !== undefined)
            );

            // Make the POST request to the rollback endpoint.
            const response = await authenticatedAxios.post(endpoint, cleanPayload);

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
            return handleAxiosError(error, `Failed to roll back item '${itemId}'`);
        }
    }
};