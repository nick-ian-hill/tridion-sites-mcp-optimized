import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const bulkReadItems = {
    name: "bulkReadItems",
    description: `Retrieves read-only details for multiple Content Manager System (CMS) items using their IDs.
This tool is more efficient than calling the 'getItem' tool for each item individually.
The returned data is an 'IdentifiableObjectDictionary' type, which maps each item ID to its details.
To control the amount of data returned, use the 'includeProperties' parameter for granular control, which is the most efficient method.
The 'useDynamicVersion' parameter can be set to true to load the latest saved data for versioned items.

The following item types are versioned: Components, Component Templates, Pages, Page Templates, Schemas,
and Template Building Blocks.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

Example: Retrieve a specific nested property for multiple items.
This example gets the revision date for two Components. The output includes the base 'Id', 'Title', and '$type' properties, plus a 'VersionInfo' object containing only the requested 'RevisionDate'.

    const result = await tools.bulkReadItems({
        itemIds: ["tcm:5-320", "tcm:5-175"],
        includeProperties: ["VersionInfo.RevisionDate"]
    });

Expected JSON Output:
{
  "tcm:5-320": {
    "Id": "tcm:5-320-v0",
    "Title": "Sitemap2",
    "$type": "Component",
    "VersionInfo": {
      "RevisionDate": "2025-08-11T05:36:08.65Z"
    }
  },
  "tcm:5-175": {
    "Id": "tcm:5-175",
    "Title": "Navigation Configuration",
    "$type": "Component",
    "VersionInfo": {
      "RevisionDate": "2025-08-14T11:20:56.17Z"
    }
  }
}
`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).describe("An array of unique IDs for the items to retrieve. Use tools like 'search' or 'getItemsInContainer' to find item IDs."),
        useDynamicVersion: z.boolean().optional().default(false).describe("When true, loads the latest revisions for versioned items. Defaults to false."),
        loadFullItems: z.boolean().optional().default(false).describe("When true, loads the full content and metadata for each item. This is ignored if 'includeProperties' is used."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response (e.g., ["LocationInfo.Path", "VersionInfo.CreationDate"]). If used, 'loadFullItems' is ignored. 'Id', 'Title', and '$type' will always be included.`),
    },
    execute: async ({ itemIds, useDynamicVersion = false, loadFullItems = false, includeProperties }: { 
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

            const response = await authenticatedAxios.get(`/items/bulkRead`, {
                params: {
                    itemIds: itemIds,
                    useDynamicVersion: useDynamicVersion,
                    loadFullItems: finalLoadFullItems,
                }
            });

            if (response.status === 200) {
                const finalData = filterResponseData({ responseData: response.data, includeProperties });
                
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(finalData, null, 2)
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