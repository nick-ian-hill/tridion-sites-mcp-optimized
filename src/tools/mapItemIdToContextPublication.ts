import { z } from "zod";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError } from "../utils/errorUtils.js";
import axios from "axios";

export const mapItemIdToContextPublication = {
    name: "mapItemIdToContextPublication",
    description: `Transforms an item ID (TCM URI) from one Publication context to another and verifies it exists.

BluePrint Visibility Rules
This tool is for debugging and error recovery only. You should NOT need to call this tool during normal creation or update operations, as other tools handle mapping to the context Publication automatically.

An item can only use dependencies (like a Schema) that exist in the same Publication. For example, primary items that were created in the same Publication, and shared/localized items that are inherited from a parent/ancestor Publication.

If this tool returns a 404 error, it means the mapped item does not exist in the target context.`,
    input: {
        itemId: z.string().describe("The item ID to be transformed (e.g., from a parent publication)."),
        contextItemId: z.string().describe("An item ID that is in the target Publication context (e.g., the child publication's folder)."),
    },
    execute: async ({ itemId, contextItemId }: { itemId: string, contextItemId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const mappedId = convertItemIdToContextPublication(itemId, contextItemId);
        
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedMappedId = mappedId.replace(/:/g, '_');

            // Use a HEAD request to efficiently check if the item exists
            await authenticatedAxios.head(`/items/${escapedMappedId}`);

            // If the HEAD request succeeds (204 No Content), the item exists.
            const responseData = {
                type: "MappedItemId",
                OriginalId: itemId,
                ContextId: contextItemId,
                MappedId: mappedId,
                Message: `Item exists: The mapped item ${mappedId} is valid.`
            };
            
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(responseData, null, 2)
                }],
            };

        } catch (error) {
            // Check if this is an Axios error and has a 404 status
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                const bluePrintError = new Error(
                    `The mapped item '${mappedId}' does not exist in the target context.
                    This is likely because the original item '${itemId}' is in a sibling or child Publication,
                    not a parent, and therefore cannot be inherited. Consider (a) using a different item that does exist in the target context,
                    (b) using the 'promoteItem' tool to promote the item(s) to a common parent, or (c) creating a new item in the target context
                    or a parent/ancestor.`
                );
                return handleAxiosError(bluePrintError, `BluePrint mapping failed`);
            }
            
            // Handle other errors (e.g., auth failure, server down)
            return handleAxiosError(error, `Failed to check existence of item ${mappedId}`);
        }
    }
};