import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getKeywordsForCategory = {
    name: "getKeywordsForCategory",
    description: `Retrieves the list of keywords for the specified category, including nested keywords. This is the second step in finding keywords, used after 'getCategories'. The keyword IDs returned by this tool are used as input for tools like 'classify', and 'getClassifiedItems'.
        Keywords can be associated with items via 'keyword' fields in an item's content or metadata.
    Keywords with the 'Abstract' property set to true are typically used for definining hierarchical navigation.
    Keywords with the 'Abstract' property set to false can be used for both navigation and for classifying items.
    When used in classification, the keywords' title property is usually assumed to reflect some aspect of the item's content/metadata.
    typically used to determine whether a keywordof the keyword typically what would be to navigatiofor a given parent Category or Keyword.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the category (e.g., 'tcm:5-123-512'). Use 'getCategories' to find a Category ID."),
    },
    execute: async ({ itemId }: { itemId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const endpoint = `/items/${restItemId}/keywords`;
            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                const formattedResponseData = formatForAgent(response.data);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve keywords for item '${itemId}'`);
        }
    }
};