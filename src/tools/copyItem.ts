import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const copyItem = {
    name: "copyItem",
    description: `Creates a copy/duplicate of the item in the specified destination. This is different from the 'moveItem' tool, which relocates the original item.
    The tool will automatically ensure that the title of the copied item is unique in the destination container.
    Items can only be copied to containers of the same type (Folder to Folder, StructureGroup to StructureGroup).
    The ID of an item's container is given by the 'LocationInfo/OrganizationalItem/IdRef' property.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to be copied. Use 'search' or 'getItemsInContainer' to find the item's ID."),
        destinationId: z.string().regex(/^tcm:\d+-\d+-(2|4|512|1024)$/).describe("The TCM URI of the destination Folder, Structure Group, Category, or Keyword. Use 'search' or 'getItemsInContainer' to find a destination. Setting this to the item's current location will create a duplicate with a unique title.")
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
                let responseData;
                if (response.data) {
                    responseData = {
                        type: response.data['$type'],
                        Id: response.data.Id,
                        Message:`Successfully copied ${response.data.Id}`
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
            return handleAxiosError(error, `Failed to copy item ${itemId}`);
        }
    }
};