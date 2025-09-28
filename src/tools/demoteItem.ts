import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const demoteItem = {
    name: "demoteItem",
    description: `Demotes a shared item down the BluePrint hierarchy to a child Publication. This action breaks the inheritance from a parent by creating a localized copy of the item in the selected child Publication. The operation will fail if the item is not shared from the specified Publication.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the shared item to demote."),
        destinationRepositoryId: z.string().regex(/^tcm:\d+-\d+-1$/).describe("The TCM URI of the child Publication to demote the item to."),
        recursive: z.boolean().optional().default(false).describe("Specifies whether the operation should be performed recursively. If true when demoting an Organizational Item, all nested items are demoted as well."),
    },
    execute: async ({ itemId, destinationRepositoryId, recursive = false }: { itemId: string; destinationRepositoryId: string; recursive: boolean }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const requestModel = {
                DestinationRepositoryId: destinationRepositoryId,
                Instruction: {
                    "$type": "OperationInstruction",
                    Recursive: recursive
                }
            };

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/demote`, requestModel);

            if (response.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully demoted item ${itemId} to ${destinationRepositoryId}.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to demote item ${itemId}`);
        }
    }
};