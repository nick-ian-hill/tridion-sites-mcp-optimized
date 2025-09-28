import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
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

Example 1: Finds all items that are directly using a Schema, returning only their IDs and titles.
    const result = await tools.dependencyGraphForItem({
        itemId: "tcm:5-256-8",
        direction: "UsedBy",
        details: "IdAndTitle"
    });

Example 2: Finds all Components used by a Page, returning the base properties plus 'VersionInfo.RevisionDate' for each item in the dependency tree.
    const result = await tools.dependencyGraphForItem({
        itemId: "tcm:5-314-64",
        direction: "Uses",
        rloItemTypes: ["Component"],
        includeProperties: ["VersionInfo.RevisionDate"]
    });

Expected JSON Output for Example 2:
{
  "$type": "DependencyGraphNode",
  "Dependencies": [
    {
      "$type": "DependencyGraphNode",
      "Dependencies": [
        {
          "$type": "DependencyGraphNode",
          "Dependencies": [],
          "HasMore": false,
          "Item": {
            "Id": "tcm:5-292",
            "Title": "blueprint",
            "$type": "Component",
            "VersionInfo": {
              "RevisionDate": "2025-09-26T09:12:50.293Z"
            }
          }
        }
      ],
      "HasMore": false,
      "Item": {
        "Id": "tcm:5-307",
        "Title": "All Articles Intro",
        "$type": "Component",
        "VersionInfo": {
          "RevisionDate": "2025-09-26T09:12:54.043Z"
        }
      }
    },
    {
      "$type": "DependencyGraphNode",
      "Dependencies": [
        {
          "$type": "DependencyGraphNode",
          "Dependencies": [],
          "HasMore": false,
          "Item": {
            "Id": "tcm:5-304",
            "Title": "calculator",
            "$type": "Component",
            "VersionInfo": {
              "RevisionDate": "2025-09-26T09:12:53.303Z"
            }
          }
        }
      ],
      "HasMore": false,
      "Item": {
        "Id": "tcm:5-305",
        "Title": "Articles Intro",
        "$type": "Component",
        "VersionInfo": {
          "RevisionDate": "2025-09-26T09:12:53.593Z"
        }
      }
    },
    {
      "$type": "DependencyGraphNode",
      "Dependencies": [],
      "HasMore": false,
      "Item": {
        "Id": "tcm:5-280",
        "Title": "Company News Media Manager Video",
        "$type": "Component",
        "VersionInfo": {
          "RevisionDate": "2025-09-26T09:12:47.003Z"
        }
      }
    }
}
`,
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
        resultLimit: z.number().int().optional().default(100).describe("The maximum number of dependency nodes to return."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail for the returned items. For custom property selection, use 'includeProperties' instead.`),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response. If used, the 'details' parameter is ignored. The base properties 'Id', 'Title', and '$type' will always be included.`),
    },
    execute: async ({ itemId, direction = "Uses", contextRepositoryId, rloItemTypes, includeContainers = false, resultLimit = 100, details = "IdAndTitle", includeProperties }: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
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