import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const copyItem = {
    name: "copyItem",
    description: `Copies the specified item to a new location. This is different from the 'moveItem' tool, which relocates the original item.
    It is only possible to copy an item to a destination where the 'BlueprintInfo.IsLocalized' and 'BlueprintInfo.IsShared' properties are both 'false'. You can check these properties using the 'getItem' tool.
    The title of the copied item must be unique in the destination container.
    Items can only be copied to containers of the same type (Folder to Folder, StructureGroup to StructureGroup).
    The ID of the container is given by the 'LocationInfo/OrganizationalItem/IdRef' property.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to be copied. Use 'search' or 'getItemsInContainer' to find the item's ID."),
        destinationId: z.string().regex(/^tcm:\d+-\d+-(2|4)$/).describe("The TCM URI of the destination Folder or Structure Group. Use 'search' or 'getItemsInContainer' to find a destination.")
    },
    execute: async ({ itemId, destinationId }: { itemId: string, destinationId: string },
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const escapedDestinationId = destinationId.replace(':', '_');

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/copy/${escapedDestinationId}`);

            if (response.status === 200 || response.status === 204) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully copied item ${itemId} to ${destinationId}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }

        } catch (error) {
            return handleAxiosError(error, `Failed to copy item ${itemId}`);
        }
    }
};