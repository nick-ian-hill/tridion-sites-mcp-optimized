import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getCategories = {
    name: "getCategories",
    description: `Retrieves the list of categories for a specified publication. This is the first step in finding available keywords. After getting a category's ID from this tool, use 'getKeywordsForCategory' to see the keywords within it.
    A category represents a set of keywords, possibly hierarchically structured.
    Keyword hierarchies arise when one or more keywords has one or more parent keywords.
    Parent keywords are defined in the child keyword.
    Parent keywords must belong to the same category as the child keyword.
    Circular references are not permitted.`,
    input: {
        itemId: z.string().regex(/^tcm:0-[1-9]\d*-1$/).describe("The unique ID of a Publication (e.g., 'tcm:0-5-1'). Use 'getPublications' to find a Publication ID."),
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a level of detail for the returned items. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns only the ID and Title of each item. This is the most efficient option, and the best choice if you only need a list of items matching the query.
- "CoreDetails": Returns the main properties of each item, excluding verbose security, link-related, and content/field-related information.
- "AllDetails": Returns all available properties for each item, excluding content/field data.`),
        includeProperties: z.array(z.string()).optional().describe(`Takes precedence over the 'details' parameter. Provide an array of property names to include in the response. 'Id', 'Title', and '$type' are always included. Refer to the 'getItem' tool description for a comprehensive list of available properties.`),
    },
    execute: async ({ itemId, details = "IdAndTitle", includeProperties }: { 
        itemId: string,
        details?: "IdAndTitle" | "CoreDetails" | "AllDetails",
        includeProperties?: string[]
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/categories`;
            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                let finalData;
                const responseData = response.data;
                const hasCustomProperties = includeProperties && includeProperties.length > 0;

                if (hasCustomProperties) {
                    finalData = filterResponseData({ responseData, includeProperties });
                } else {
                    const items = Array.isArray(responseData) ? responseData : [responseData];
                    let filteredItems;

                    switch (details) {
                        case 'IdAndTitle':
                            const propsToInclude = new Set(['Id', 'Title', '$type', 'ExtensionProperties']);
                            filteredItems = items.map(item => {
                                const filteredItem: { [key: string]: any } = {};
                                propsToInclude.forEach(prop => {
                                    if (prop in item) {
                                        filteredItem[prop] = item[prop];
                                    }
                                });
                                return filteredItem;
                            });
                            break;
                        
                        case 'CoreDetails':
                            const propsToExclude = new Set([
                                'AccessControlList',
                                'ApplicableActions',
                                'ApprovalStatus',
                                'ContentSecurityDescriptor',
                                'ListLinks',
                                'SecurityDescriptor',
                                'LoadInfo'
                            ]);
                            filteredItems = items.map(item => 
                                Object.fromEntries(
                                    Object.entries(item).filter(([key]) => !propsToExclude.has(key))
                                )
                            );
                            break;

                        case 'AllDetails':
                        default:
                            filteredItems = items;
                            break;
                    }
                    finalData = Array.isArray(responseData) ? filteredItems : filteredItems[0];
                }

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
            return handleAxiosError(error, `Failed to retrieve categories for publication '${itemId}'`);
        }
    }
};