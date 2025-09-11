import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const dependencyGraphForItem = {
    name: "dependencyGraphForItem",
    description: `Returns items in the Content Management System that are either dependencies of (direction = uses) or dependent on (direction = UsedBy) the specified item.
IMPORTANT: Requesting details for many items can return a large amount of data. Use 'IdAndTitle' or the 'includeProperties' parameter for the most efficient and reliable results.
Only select "AllDetails" if you absolutely need full details about the returned items. This request will likely fail with a large number of item (resultLimit > 150). 'AllDetails' adds the following properties to 'CoreDetails':
  - AccessControlList
  - ApplicableActions
  - ApprovalStatus
  - ContentSecurityDescriptor
  - ExtensionProperties
  - ListLinks
  - SecurityDescriptor
  - LoadInfo

Examples:

Example 1: Finds all items that are directly using the Schema with ID tcm:5-256-8, returning only their IDs and titles.
    const result = await tools.dependencyGraphForItem({
        itemId: "tcm:5-256-8",
        direction: "UsedBy",
        details: "IdAndTitleOnly"
    });

Example 2: Finds all Components and Component Templates that the Page tcm:5-310-64 depends on, including the Folders that contain them. This request returns linked Components in addition to Components directly added to the page.
    const result = await tools.dependencyGraphForItem({
        itemId: "tcm:5-310-64",
        direction: "Uses",
        rloItemTypes: ["Component", "ComponentTemplate"],
        includeContainers: true
    });`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item for which the dependency graph should be retrieved."),
        direction: z.enum(["Uses", "UsedBy"]).optional().default("Uses").describe("Specifies the direction of the dependencies. 'Uses' returns items this item depends on; 'UsedBy' returns items that depend on this item."),
        contextRepositoryId: z.string().regex(/^tcm:0-\d+-1$/).optional().describe("The TCM URI of an ancestor Publication. If specified, the response will indicate whether the dependent items exist in this Publication."),
        rloItemTypes: z.array(z.enum([
            "Component",
            "Page",
            "Schema",
            "ComponentTemplate",
            "PageTemplate",
            "TemplateBuildingBlock",
            "BusinessProcessType",
            "VirtualFolder",
            "ProcessDefinition",
            "Folder",
            "StructureGroup",
            "Category",
            "Keyword",
            "TargetGroup",
        ])).optional().describe("Filters the results to include only these types of repository-local objects."),
        includeContainers: z.boolean().optional().default(false).describe("If true and direction is 'Uses', the parent Folders or Structure Groups of the items in the graph are also returned (recursively)."),
        resultLimit: z.number().int().optional().default(1000).describe("The maximum number of dependency nodes to return."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail for the returned items. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns only the ID and Title of each item. This is the recommended default.
- "CoreDetails": Returns the main properties, excluding verbose security and link-related information. This may be slow or fail if the graph is large.
- "AllDetails": Returns all available properties for each item. This is likely to fail on large graphs.`),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response. If used, the 'details' parameter is ignored. 'Id', 'Title', and '$type' will always be included.`),
    },
    execute: async ({ itemId, direction, contextRepositoryId, rloItemTypes, includeContainers, resultLimit, details, includeProperties }: any) => {
        try {
            const restItemId = itemId.replace(':', '_');
            
            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            const apiDetails = hasCustomProperties || details === 'CoreDetails' || details === 'AllDetails'
                ? 'Contentless'
                : 'IdAndTitleOnly';

            const params = { direction, contextRepositoryId, rloItemTypes, includeContainers, resultLimit, details: apiDetails };
            const cleanParams = Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined));
            
            const response = await authenticatedAxios.get(`/items/${restItemId}/dependencyGraph`, {
                params: cleanParams
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
            return handleAxiosError(error, `Failed to retrieve dependency graph for item ${itemId}`);
        }
    }
};