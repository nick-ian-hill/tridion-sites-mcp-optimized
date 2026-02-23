import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const bulkReadItems = {
    name: "bulkReadItems",
    description: `Retrieves read-only details for multiple Content Manager System (CMS) items using their IDs.
This tool is the most efficient way to get 'Content', 'Metadata', or 'BinaryContent' properties for multiple items. To retrieve them, you use the 'includeProperties' parameter (e.g., ['Metadata', 'BinaryContent.Size']).
The returned data is an 'IdentifiableObjectDictionary' type, which maps each item ID to its details.
To control the amount of data returned, use the 'includeProperties' parameter for granular control, which is the most efficient method.
The 'useDynamicVersion' parameter can be set to true to load the latest saved data for versioned items.
For versioned item types (Components, Component Templates, Pages, Page Templates, Template Building Blocks and Schemas), this tool returns the most recent saved data (dynamic version) by default.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

Strategy for tasks requiring post-processing or aggregation of results (e.g., "Find the Most...", "Count all...")
When post-processing of data from a large set of items is required, do not use this tool directly.
This approach is token-inefficient and will fail on large result sets. The correct, scalable method is to use the 'toolOrchestrator', and supply a postProcessingScript to perform the aggregation on the server-side. See the 'toolOrchestrator' documentation for the recommended 3-phase (setup-map-reduce) pattern.

Example: Retrieve a specific nested property for multiple items.
This example gets the revision date for two Components. The output includes the base 'Id', 'Title', and 'type' properties, plus a 'VersionInfo' object containing only the requested 'RevisionDate'.

    const result = await tools.bulkReadItems({
        itemIds: ["tcm:5-320", "tcm:5-175"],
        includeProperties: ["VersionInfo.RevisionDate"]
    });

Expected JSON Output:
{
  "tcm:5-320": {
    "Id": "tcm:5-320",
    "Title": "Sitemap2",
    "type": "Component",
    "VersionInfo": {
      "RevisionDate": "2025-08-11T05:36:08.65Z"
    }
  },
  "tcm:5-175": {
    "Id": "tcm:5-175",
    "Title": "Navigation Configuration",
    "type": "Component",
    "VersionInfo": {
      "RevisionDate": "2025-08-14T11:20:56.17Z"
    }
  }
}
`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?(-v\d+)?|ecl:[^:\s]+(-v\d+)?)$/)).describe("An array of unique IDs for the items to retrieve. Use tools like 'search' or 'getItemsInContainer' to find item IDs. To retrieve a specific historical version, append the version number to the ID (e.g., 'tcm:5-123-v2' or 'tcm:5-123-64-v1')."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Defaults to true. For versioned items (Components, Pages, Templates, Schemas), this retrieves the latest saved state (dynamic version), including minor revisions and checked-out changes. Set to false to strictly retrieve the last checked-in major version. This parameter is ignored for non-versioned items."),
        loadFullItems: z.boolean().optional().default(false).describe("When true, loads the full content and metadata for each item (where applicable), and BinaryContent for Multimedia Components (components with 'ComponentType' = 'Multimedia'). This is ignored if 'includeProperties' is used."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response (e.g., ['LocationInfo.Path', 'VersionInfo.CreationDate', 'Content', 'Metadata', 'BinaryContent.MimeType']). If used, 'loadFullItems' is ignored. 'Id', 'Title', and 'type' will always be included. Refer to the 'getItem' tool description for a comprehensive list of available properties.`),
    },
    execute: async ({ itemIds, useDynamicVersion = true, loadFullItems = false, includeProperties }: { 
        itemIds: string[], 
        useDynamicVersion?: boolean, 
        loadFullItems?: boolean,
        includeProperties?: string[]
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            const finalLoadFullItems = hasCustomProperties || loadFullItems;

            const response = await authenticatedAxios.post(
                `/items/bulkRead`,
                itemIds,
                {
                    params: {
                        useDynamicVersion: useDynamicVersion,
                        loadFullItems: finalLoadFullItems,
                    }
                }
            );

            if (response.status === 200) {
                const finalData = filterResponseData({ responseData: response.data, includeProperties });
                const formattedData = formatForAgent(finalData);

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedData, null, 2)
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to authenticate or retrieve items");
        }
    }
};