import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const itemTypeEnum = z.enum([
    "Bundle",
    "BusinessProcessType",
    "Category",
    "Component",
    "ComponentTemplate",
    "ExternalCategory",
    "ExternalComponent",
    "ExternalContainer",
    "ExternalKeyword",
    "Folder",
    "Keyword",
    "Page",
    "PageTemplate",
    "ResolvedBundle",
    "Schema",
    "SearchFolder",
    "StructureGroup",
    "TargetGroup",
    "TemplateBuildingBlock"
]);

export const getItemsInContainer = {
    name: "getItemsInContainer",
    summary: "Lists all items (Components, Pages, Folders, etc.) within a specific container. Supports recursive listing.",
    description: `Gets a list of items (Id, Title, type) inside a specified container (e.g., a Publication, Folder, Structure Group).

    NOTE: To retrieve all classification Keywords from a Category (including nested keywords), use the dedicated 'getClassificationKeywordsForCategory' tool instead.
    
    IMPORTANT: This tool returns ONLY identification data. It does NOT return Content, Metadata, or other properties.
    To retrieve item details:
    1. Use this tool to get the item IDs.
    2. Use 'getItem' in the mapScript of the 'toolOrchestrator', or 'bulkReadItems' in a 'toolOrchestrator' preProcessingScript. These tools have an includeProperties input parameter that can be used to efficiently request the relevant item properties. A comprehensive list of available properties is documented in the 'getItem' tool.`,
    input: {
        containerId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/).describe("The TCM URI or ECL URI of the container item."),
        recursive: z.boolean().optional().default(false).describe("Set to `true` to include items from all nested sub-containers."),
        useDynamicVersion: z.boolean().optional().default(true).describe("The default setting of `true` ensures that the latest data is returned for versioned items."),
        itemTypes: z.array(itemTypeEnum).optional().describe("An array of item types to filter the results, e.g., ['Component', 'Page', 'Folder']. If omitted, all item types are returned."),
    },
    execute: async ({ containerId, recursive = false, useDynamicVersion = true, itemTypes }: {
        containerId: string,
        recursive?: boolean,
        useDynamicVersion?: boolean,
        itemTypes?: string[]
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedContainerId = containerId.replace(':', '_');

            const apiDetails = 'IdAndTitleOnly';

            const response = await authenticatedAxios.get(`/items/${escapedContainerId}/items`, {
                params: {
                    recursive: recursive,
                    useDynamicVersion: useDynamicVersion,
                    rloItemTypes: itemTypes,
                    details: apiDetails,
                }
            });

            if (response.status === 200) {
                const finalData = filterResponseData({
                    responseData: response.data,
                    details: "IdAndTitle"
                });
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
    },
    examples: [
    ]
};