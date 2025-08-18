import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const promoteItem = {
    name: "promoteItem",
    description: `Promotes a shared item up the BluePrint hierarchy to a parent Publication. This action makes a shared copy of the item available in the selected parent, allowing content to be managed centrally and reused in child Publications. The operation will fail if the item is already promoted to the specified destination.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The unique ID (TCM URI) of the shared item to promote."),
        destinationRepositoryId: z.string().regex(/^tcm:\d+-\d+-1$/).describe("The TCM URI of the parent Publication to promote the item to."),
        recursive: z.boolean().optional().default(false).describe("Specifies whether the operation should be performed recursively. If true, all linked items (recursively) are promoted too if they don't already exist in the destination Publication."),
    },
    execute: async ({ itemId, destinationRepositoryId, recursive }: { itemId: string; destinationRepositoryId: string; recursive: boolean }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const requestModel = {
                DestinationRepositoryId: destinationRepositoryId,
                Instruction: {
                    "$type": "OperationInstruction",
                    Recursive: recursive
                }
            };

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/promote`, requestModel);

            if (response.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully promoted item ${itemId} to ${destinationRepositoryId}.\n\n${JSON.stringify(response.data, null, 2)}`
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