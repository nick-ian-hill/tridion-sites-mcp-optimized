import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

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
    execute: async ({ itemId, destinationId }: { itemId: string, destinationId: string }) => {
        try {
            // Escape the IDs for the API endpoint URL by replacing the colon with an underscore.
            const escapedItemId = itemId.replace(':', '_');
            const escapedDestinationId = destinationId.replace(':', '_');

            // Make the POST request to the move endpoint.
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/move/${escapedDestinationId}`);

            // A successful move can return 200 (with the moved item in the body) or 204 (no content).
            if (response.status === 200 || response.status === 204) {
                const responseData = response.data ? `\n\n${JSON.stringify(response.data, null, 2)}` : " The operation returned no content.";
                return {
                    content: [{
                        type: "text",
                        text: `Successfully moved item ${itemId} to ${destinationId}.${responseData}`
                    }],
                };
            } else {
                // Handle any other unexpected, non-error status codes.
                return {
                    content: [],
                    errors: [{ message: `Unexpected response status during move operation: ${response.status}` }],
                };
            }

        } catch (error) {
            // Handle errors from the API call, providing detailed feedback.
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to move item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};