import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getItemsInContainer = {
    name: "getItemsInContainer",
    description: `Gets a list of items inside a specified container item (e.g., a Publication, Folder, Structure Group, Category, or Bundle).
IMPORTANT: Requesting details for many items can return a large amount of data. Use 'IdAndTitle' or the 'includeProperties' parameter for the most efficient and reliable results, especially when using the 'recursive' option.`,
    input: {
        containerId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI or ECL URI of the container item."),
        recursive: z.boolean().optional().default(false).describe("If true, items in nested containers are also returned recursively. This is not applicable for External Containers. Typically this value would be set to true when searching for a Page Template or other dependency anywhere in a Publication."),
        useDynamicVersion: z.boolean().optional().default(false).describe("If true, loads the latest saved version (dynamic version) for any versioned items returned."),
        itemTypes: z.array(z.string()).optional().describe("An array of item types to filter the results, e.g., ['Component', 'Page', 'Folder']. If omitted, all item types are returned."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail for the returned items. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns only the ID and Title of each item. This is the recommended default.
- "CoreDetails": Returns the main properties, excluding verbose security and link-related information. This may be slow or fail if the container holds many items.
- "AllDetails": Returns all available properties for each item. This is likely to fail if the container holds many items.`),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response. If used, the 'details' parameter is ignored. 'Id', 'Title', and '$type' will always be included.`),
    },
    execute: async ({ containerId, recursive, useDynamicVersion, itemTypes, details, includeProperties }: { 
        containerId: string, 
        recursive?: boolean, 
        useDynamicVersion?: boolean, 
        itemTypes?: string[], 
        details?: "IdAndTitle" | "CoreDetails" | "AllDetails",
        includeProperties?: string[]
    }) => {
        try {
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
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(finalData, null, 2)
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