import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const bulkReadItems = {
    name: "bulkReadItems",
    summary: "Retrieves details for multiple CMS items at once. More efficient than multiple 'getItem' calls for bulk data retrieval.",
    description: `Retrieves read-only details for multiple Content Manager System (CMS) items using their IDs.
This tool is the most efficient way to get 'Content', 'Metadata', or 'BinaryContent' properties for multiple items. To retrieve them, you use the 'includeProperties' parameter (e.g., "includeProperties": ['Metadata', 'BinaryContent.Size']).
The returned data is an 'IdentifiableObjectDictionary' type, which maps each item ID to its details.
The 'useDynamicVersion' parameter can be set to true to load the latest saved data for versioned items.
For versioned item types (Components, Component Templates, Pages, Page Templates, Template Building Blocks and Schemas), this tool returns the most recent saved data (dynamic version) by default.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

Strategy for tasks requiring post-processing or aggregation:
When post-processing of data from a large set of items is required (e.g., "Find the Most...", "Count all..."), do not use this tool directly. This approach is token-inefficient. The correct method is to use the 'toolOrchestrator' and supply a mapScript to perform the logic on the server-side.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?(-v\d+)?|ecl:[^:\s]+(-v\d+)?)$/)).describe("An array of unique IDs for the items to retrieve. Use tools like 'search' or 'getItemsInContainer' to find item IDs. To retrieve a specific historical version, append the version number to the ID (e.g., 'tcm:5-123-v2' or 'tcm:5-123-64-v1')."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Defaults to true. For versioned items (Components, Pages, Templates, Schemas), this retrieves the latest saved state (dynamic version). Set to false to retrieve the last checked-in major version."),
        loadFullItems: z.boolean().optional().default(false).describe("When true, loads full content/metadata. Ignored if 'includeProperties' is used."),
        includeProperties: z.array(z.string()).optional().describe("Provide an array of property names to include (e.g., ['VersionInfo.CreationDate', 'Content', 'Metadata']). 'Id', 'Title', and 'type' are always included."),
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
    },
    examples: [
        {
            description: "Retrieve basic properties plus the RevisionDate from the VersionInfo of two specific items.",
            payload: `const result = await tools.bulkReadItems({
    itemIds: ["tcm:5-123-16", "tcm:5-456-16"],
    includeProperties: ["Id", "Title", "type", "VersionInfo.RevisionDate"]
});`
        }
    ]
};