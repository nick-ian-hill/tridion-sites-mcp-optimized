import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const getCategories = {
    name: "getCategories",
    description: `Retrieves the list of categories for the specified publication.
    A category represents a set of keywords, possibly hierarchically structured.
    Keyword hierarchies arise when one or more keywords has one or more parent keywords.
    Parent keywords are defined in the child keyword.
    Parent keywords must belong to the same category as the child keyword.
    Circular references are not permitted.`,
    input: {
        itemId: z.string().regex(/^tcm:0-[1-9]\d*-1$/).describe("The unique ID of a Publication (e.g., 'tcm:0-5-1')."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            const restItemId = itemId.replace(':', '_');

            // Construct the API endpoint URL with the provided escaped item ID.
            const endpoint = `/api/v3.0/items/${restItemId}/categories`;

            // Make a GET request to the categories endpoint.
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
                errors: [{ message: `Failed to retrieve categories for publication '${itemId}': ${errorMessage}` }],
            };
        }
    }
};