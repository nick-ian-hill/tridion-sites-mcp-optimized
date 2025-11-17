import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getItemsInContainer = {
    name: "getItemsInContainer",
    description: `Gets a list of items inside a specified container (e.g., a Publication, Folder, Structure Group, Category, or Bundle). This is a primary discovery tool, often used to find the IDs of items to be used in other tools like 'getItem', 'updateContent', 'deleteItem', etc. It's best for browsing a known structure, whereas the 'search' tool is better for finding items across the entire system based on criteria.
IMPORTANT: Use 'IdAndTitle' or 'includeProperties' for efficiency, especially with the 'recursive' option.

This tool is optimized for browsing and returns a list of items, but NOT their full data. Properties like 'Content', 'Metadata' (the values), and 'BinaryContent' (MimeType, Size) are NEVER returned by this tool.

To read these properties, you must use the "find-then-fetch" pattern:
1.  Use this tool ('getItemsInContainer') to get the item IDs.
2.  Use 'getItem' or 'bulkReadItems' with 'includeProperties' to fetch the relevant data for those IDs.

See the 'toolOrchestrator' tool for examples of how to automate this pattern.

Strategy for tasks requiring post-processing or aggregation of results (e.g., "Find the Most...", "Count all...")
When post-processing of data from a large set of items is required, do not use this tool directly.
This approach is token-inefficient and will fail on large result sets. The correct, scalable method is to use the 'toolOrchestrator', and supply a postProcessingScript to perform the aggregation on the server-side. See the 'toolOrchestrator' documentation for the recommended 3-phase (setup-map-reduce) pattern.

`,
    input: {
        containerId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI or ECL URI of the container item."),
        recursive: z.boolean().optional().default(false).describe("Set to `true` to include items from all nested sub-containers. Use this for broad searches (e.g., 'find all images in the current Publication'), not for simply listing the contents of a single folder (e.g., 'what's in the 2025 folder?')."),
        useDynamicVersion: z.boolean().optional().default(true).describe("The default setting of `true` ensures that the latest data is returned for versioned items and that the response includes new items."),
        itemTypes: z.array(z.string()).optional().describe("An array of item types to filter the results, e.g., ['Component', 'Page', 'Folder']. If omitted, all item types are returned."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns the ID, Title, and type of each item. This is the recommended default.
- "CoreDetails": Returns the main properties, excluding verbose security and link-related information. This may be slow or fail if the container holds many items.
- "AllDetails": Returns all available properties for each item. This is likely to fail if the container holds many items.`),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response. If used, the 'details' parameter is ignored. 'Id', 'Title', and 'type' will always be included.`),
    },
    execute: async ({ containerId, recursive = false, useDynamicVersion = true, itemTypes, details = "IdAndTitle", includeProperties }: { 
        containerId: string, 
        recursive?: boolean, 
        useDynamicVersion?: boolean, 
        itemTypes?: string[], 
        details?: "IdAndTitle" | "CoreDetails" | "AllDetails",
        includeProperties?: string[]
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedContainerId = containerId.replace(':', '_');

            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            const apiDetails = hasCustomProperties || details === 'CoreDetails' || details === 'AllDetails'
                ? 'Contentless'
                : 'IdAndTitleOnly';

            const response = await authenticatedAxios.get(`/items/${escapedContainerId}/items`, {
                params: {
                    recursive: recursive,
                    useDynamicVersion: useDynamicVersion,
                    rloItemTypes: itemTypes,
                    details: apiDetails,
                }
            });

            if (response.status === 200) {
                const finalData = filterResponseData({ responseData: response.data, details, includeProperties });
                const formattedFinalData = formatForAgent(finalData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedFinalData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve items from container");
        }
    }
};