import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getUsesForVersionInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
        .describe("The unique ID (TCM URI) of the versioned item to inspect."),
    version: z.number().int().min(1)
        .describe("The specific major version number of the item to inspect (e.g., 12)."),
};

const getUsesForVersionSchema = z.object(getUsesForVersionInputProperties);

export const getUsesForVersion = {
    name: "getUsesForVersion",
    description: `Retrieves a list of items that were used by a *specific version* of a specified item.
    
    This tool is useful for historical analysis, such as reconstructing a Page's dependencies at a particular point in time.
    It differs from 'getDependencyGraph' (with direction 'Uses'), which shows dependencies for the *current* state of an item.
    
    ### "Find-Then-Fetch" Pattern
    This tool returns minimal identification data (Id, Title, type).
    
    To analyze the historical dependencies:
    1.  **Find:** Use this tool to get the list of used item IDs.
    2.  **Fetch:** Use the 'toolOrchestrator' to call 'getItem' in combination with the 'includeProperties' input parameter if additional information is required. The 'getItem' tool provides a comprehensive list of available properties.
    
Example:
Find all items that were used by version 12 of the Page 'tcm:5-263-64'.

    const result = await tools.getUsesForVersion({
        itemId: "tcm:5-263-64",
        version: 12,
        details: "IdAndTitle"
    });

Expected JSON Output (example is truncated for brevity):
[
  {
    "type": "Schema",
    "Id": "tcm:5-181-8",
    "Title": "[Article] Region"
  },
  {
    "type": "Component",
    "Id": "tcm:5-278",
    "Title": "Company News Media Manager Video"
  },
  {
    "type": "PageTemplate",
    "Id": "tcm:5-219-128",
    "Title": "Home Page"
  },
  {
    "type": "Keyword",
    "Id": "tcm:5-310-1024",
    "Title": "000 Home"
  }
]`,

    input: getUsesForVersionInputProperties,

    execute: async (
        input: z.infer<typeof getUsesForVersionSchema>,
        context: any
    ) => {
        const { itemId, version } = input;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const versionedItemId = `${itemId}-v${version}`;
            const escapedItemId = versionedItemId.replace(':', '_');
            const endpoint = `/items/${escapedItemId}/uses`;

            const apiDetails = 'IdAndTitleOnly';

            const response = await authenticatedAxios.get(endpoint, {
                params: {
                    includeBlueprintParentItem: false,
                    useDynamicVersion: false,
                    details: apiDetails
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
            return handleAxiosError(error, `Failed to retrieve uses for item ${itemId} version ${version}`);
        }
    }
};