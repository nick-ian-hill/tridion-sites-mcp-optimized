import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const getPublications = {
    name: "getPublications",
    description: `Retrieves a list of all Publications in the Content Management System.
  Since the Title property of a Publication must be unique, this tool can be used to lookup the TCM URI of a Publication when only the Title is known.
  For this use case, the tool should be used with the 'details' level set to 'IdAndTitleOnly' since additional data is not required.`,
    input: {
        details: z.enum(["IdAndTitleOnly", "WithApplicableActions", "Contentless"]).optional().default("IdAndTitleOnly").describe("Specifies the level of detail for the returned publications. Contentless returns the most detail. If full details of an individual Publication are required, it should be obtained using getItemById."),
    },
    execute: async ({ details }: { details?: "IdAndTitleOnly" | "WithApplicableActions" | "Contentless" }) => {
        try {
            // Make the GET request to the publications endpoint.
            const response = await authenticatedAxios.get('/publications', {
                params: {
                    details
                }
            });

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
            // Handle errors from the API call, such as a 500 Internal Server Error.
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to retrieve publications: ${errorMessage}` }],
            };
        }
    }
};