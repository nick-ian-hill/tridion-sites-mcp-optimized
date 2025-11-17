import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const moveItem = {
    name: "moveItem",
    description: `Moves the specified item to a new location. This is different from the 'copyItem' tool, which creates a duplicate and leaves the original in place.
    IMPORTANT: Moving has strict conditions related to BluePrinting. 
    In particular, it is only possible to move 'primary' items – items for which 'BlueprintInfo.IsLocalized' and 'BlueprintInfo.IsShared' properties are both 'false'.
    The destination container also needs to be a primary item.
    Use the 'getItem' tool to inspect the 'BlueprintInfo' properties of both the item to be moved and the destination.
    Moving will also fail if the destination container already contains an item of the same type with the same title.

    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a Folder can only be moved to a Folder.
    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a StructureGroup can only be moved to a StructureGroup.
    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a Category can be moved to either another Keyword (in the same Category) or the Category.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to be moved. Use 'search' or 'getItemsInContainer' to find the item's ID."),
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
                let responseData;
                if (response.data) {
                    responseData = {
                        type: response.data['$type'],
                        Id: response.data.Id,
                        Message: `Successfully moved ${response.data.Id}`
                    };
                }
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
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