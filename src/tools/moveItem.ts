import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const moveItem = {
    name: "moveItem",
    description: `Moves the specified item to a new location.
    It is only possible to move an item if its 'BlueprintInfo.IsLocalized' and 'BlueprintInfo.IsShared' properties are both 'false'.
    The 'BlueprintInfo.IsLocalized' and 'BlueprintInfo.IsShared' properties of the destination item must be 'false'.
    Moving will fail if the destination container already contains an item with the same title.
    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a Folder can only be moved to a Folder.
    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a StructureGroup can only be moved to a StructureGroup.
    Only items for which the 'LocationInfo/OrganizationalItem/IdRef' property refences a Folder or StructureGroup can be moved.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to be moved."),
        destinationId: z.string().regex(/^tcm:\d+-\d+-[24]$/).describe("The TCM URI of the destination Folder or Structure Group.")
    },
    execute: async ({ itemId, destinationId }: { itemId: string, destinationId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const escapedDestinationId = destinationId.replace(':', '_');
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/move/${escapedDestinationId}`);

            if (response.status === 200 || response.status === 204) {
                const responseData = response.data ? `\n\n${JSON.stringify(response.data, null, 2)}` : " The operation returned no content.";
                return {
                    content: [{
                        type: "text",
                        text: `Successfully moved item ${itemId} to ${destinationId}.${responseData}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }

        } catch (error) {
            return handleAxiosError(error, `Failed to move item ${itemId}`);
        }
    }
};