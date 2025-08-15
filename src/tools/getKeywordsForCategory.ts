import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const getKeywordsForCategory = {
    name: "getKeywordsForCategory",
    description: `Retrieves the list of keywords for the specified category, including nested keywords.
    Keywords can be associated with items via 'keyword' fields in an item's content or metadata.
    Keywords with the 'Abstract' property set to true are typically used for definining hierarchical navigation.
    Keywords with the 'Abstract' property set to false can be used for both navigation and for classifying items.
    When used in classification, the keywords' title property is usually assumed to reflect some aspect of the item's content/metadata.
    typically used to determine whether a keywordof the keyword typically what would be to navigatiofor a given parent Category or Keyword.`,
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID of the category (e.g., 'tcm:5-123-512')."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            const restItemId = itemId.replace(':', '_');

            // Construct the API endpoint URL with the provided escaped item ID.
            const endpoint = `/api/v3.0/items/${restItemId}/keywords`;

            // Make a GET request to the keywords endpoint.
            const response = await authenticatedAxios.get(endpoint);

            // A successful request will return a 200 OK status.
            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }
                    ],
                };
            } else {
                // Handle any unexpected, non-error status codes.
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status: ${response.status}` },
                    ],
                };
            }
        } catch (error) {
            // Handle errors from the API call, such as a 404 Not Found or 500 Internal Server Error.
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to retrieve keywords for item '${itemId}': ${errorMessage}` }],
            };
        }
    }
};