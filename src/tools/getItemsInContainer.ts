import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getItemsInContainer = {
    name: "getItemsInContainer",
    description: `Gets a list of items inside a specified container item (e.g., a Publication, Folder, Structure Group, Category, or Bundle).`,
    input: {
        containerId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The TCM URI or ECL URI of the container item."),
        recursive: z.boolean().optional().default(false).describe("If true, items in nested containers are also returned recursively. This is not applicable for External Containers. Typically this value would be set to true when searching for a Page Template or other dependency anywhere in a Publication."),
        useDynamicVersion: z.boolean().optional().default(false).describe("If true, loads the latest saved version (dynamic version) for any versioned items returned."),
        itemTypes: z.array(z.string()).optional().describe("An array of item types to filter the results, e.g., ['Component', 'Page', 'Folder']. If omitted, all item types are returned."),
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("IdAndTitleOnly").describe("Specifies the level of detail for the returned items. 'Contentless' provides the most detail, while 'IdAndTitleOnly' is the leanest."),
    },
    execute: async ({ containerId, recursive, useDynamicVersion, itemTypes, details }: { 
        containerId: string, 
        recursive?: boolean, 
        useDynamicVersion?: boolean, 
        itemTypes?: string[], 
        details?: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" 
    }) => {
        try {
            const escapedContainerId = containerId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${escapedContainerId}/items`, {
                params: {
                    recursive: recursive,
                    useDynamicVersion: useDynamicVersion,
                    rloItemTypes: itemTypes,
                    details: details,
                }
            });

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
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