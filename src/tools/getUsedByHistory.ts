import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

// Define the input schema
const getUsedByHistoryInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
        .describe("The unique ID (TCM URI) of the item for which to find usage history."),
};

const getUsedByHistorySchema = z.object(getUsedByHistoryInputProperties);

// Define the tool
export const getUsedByHistory = {
    name: "getUsedByHistory",
    description: `Returns a list of all items that use or have previously used the specified item across all its versions.
This tool is useful for reporting and for understanding the complete historical dependencies of an item, which is different from 'getDependencyGraph' (which checks only the *current* state).
The tool returns a simplified list including each item's type, ID, title, and an array of its major version numbers that used the specified item.

Example:
Find all items that have ever used the Component "tcm:5-292" in any of their versions.

    const result = await tools.getUsedByHistory({
        itemId: "tcm:5-292"
    });

Expected JSON Output:
[
  {
    "type": "Page",
    "Id": "tcm:5-263-64",
    "Title": "000 Home",
    "Versions": [ 12, 13, 14, 15 ]
  },
  {
    "type": "Component",
    "Id": "tcm:5-321",
    "Title": "Footer",
    "Versions": [ 1 ]
  },
  {
    "type": "Page",
    "Id": "tcm:5-336-64",
    "Title": "Sitemap",
    "Versions": [ 1, 2, 3 ]
  },
  {
    "type": "Bundle",
    "Id": "tcm:5-407-8192",
    "Title": "Neu: Paket",
    "Versions": []
  }
]`,

    input: getUsedByHistoryInputProperties,

    execute: async (
        input: z.infer<typeof getUsedByHistorySchema>,
        context: any
    ) => {
        const { itemId } = input;
        
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const endpoint = `/items/${escapedItemId}/usedBy`;

            const response = await authenticatedAxios.get(endpoint, {
                params: {
                    onlyLatestVersions: false,
                    useDynamicVersion: false,
                    includeLocalCopies: false,
                    details: "IdAndTitleOnly"
                }
            });

            if (response.status === 200) {
                const rawData: any[] = response.data;
                const processedData = rawData.map((item: any) => ({
                    "type": item.$type,
                    "Id": item.Id,
                    "Title": item.Title,
                    "Versions": item.ListInfo?.Versions || []
                }));

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(processedData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve usage history for item ${itemId}`);
        }
    }
};