import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const promoteItem = {
    name: "promoteItem",
    description: `Promotes a primary item up the BluePrint hierarchy to a parent Publication. This action makes the item centrally manageable and reusable in child Publications. This is the opposite of the 'demoteItem' tool.
    Before using, it's recommended to understand the item's position in the hierarchy using the 'getBluePrintHierarchy' tool to identify a valid parent Publication to promote to.
    To check whether an item is a primary item, use the 'getItem' tool and verify that BluePrintInfo.IsLocalized and BluePrintInfo.IsShared are both false.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the shared item to promote."),
        destinationRepositoryId: z.string().regex(/^tcm:\d+-\d+-1$/).describe("The TCM URI of the parent Publication to promote the item to. Use 'getBluePrintHierarchy' to find a valid parent Publication."),
        recursive: z.boolean().optional().default(false).describe("Specifies whether the operation should be performed recursively. If true, all linked items (recursively) are promoted too if they don't already exist in the destination Publication. Use 'dependencyGraphForItem' to see the dependencies."),
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
                    Mode: "FailOnError",
                    Recursive: recursive
                }
            };

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/promote`, requestModel);

            if (response.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully promoted item ${itemId} to ${destinationRepositoryId}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to promote item ${itemId}`);
        }
    }
};