import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const copyItem = {
    name: "copyItem",
    description: `Copies the specified item to a new location.
    It is only possible to copy an item to a destination where the 'BlueprintInfo.IsLocalized' and 'BlueprintInfo.IsShared' properties are both 'false'.
    The title of the copied item must be unique in the destination container.
    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a Folder can only be copied to a Folder.
    Items for which the 'LocationInfo/OrganizationalItem/IdRef' property references a StructureGroup can only be copied to a StructureGroup.
    Only items for which the 'LocationInfo/OrganizationalItem/IdRef' property refences a Folder or StructureGroup can be copied.`,
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to be copied."),
        destinationId: z.string().regex(/^tcm:\d+-\d+-(2|4)$/).describe("The TCM URI of the destination Folder or Structure Group.")
    },
    execute: async ({ itemId, destinationId }: { itemId: string, destinationId: string }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const escapedDestinationId = destinationId.replace(':', '_');

            const response = await authenticatedAxios.post(`/items/${escapedItemId}/copy/${escapedDestinationId}`);

            if (response.status === 200 || response.status === 204) {
                const responseData = response.data ? `\n\n${JSON.stringify(response.data, null, 2)}` : " The operation returned no content.";
                return {
                    content: [{
                        type: "text",
                        text: `Successfully copied item ${itemId} to ${destinationId}.${responseData}`
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