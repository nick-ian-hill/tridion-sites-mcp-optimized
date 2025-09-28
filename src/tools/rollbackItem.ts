import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const rollbackItem = {
    name: "rollbackItem",
    description: "Rolls back an item to a specific prior version. This action creates a new major version of the item with the content and metadata from the specified older version.",
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?-v\d+$/)
            .describe("The unique ID of the item, including the specific version to roll back to (e.g., 'tcm:1-2-8-v5')."),
        comment: z.string().optional()
            .describe("An optional comment or reason for the rollback. This will be stored in the new version's history."),
    },
    execute: async ({ itemId, comment }: { itemId: string, comment?: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/rollback`;

            const payload = {
                "$type": "RollBackRequest",
                "InstructionalText": comment
            };

            const cleanPayload = Object.fromEntries(
                Object.entries(payload).filter(([_, value]) => value !== undefined)
            );

            const response = await authenticatedAxios.post(endpoint, cleanPayload);

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