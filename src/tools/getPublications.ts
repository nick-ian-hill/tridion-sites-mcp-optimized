import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getPublications = {
    name: "getPublications",
    description: `Retrieves a list of all Publications in the Content Management System.
Since the Title property of a Publication must be unique, this tool can be used to lookup the TCM URI of a Publication when only the Title is known.
IMPORTANT: Requesting a high level of detail for many items can be slow or cause the request to fail. For the most efficient and reliable results, prefer using 'details: "IdAndTitle"' or the 'includeProperties' parameter to request only the specific data you need.`,
    input: {
        details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional().describe(`Specifies a predefined level of detail for the returned publications. For custom property selection, use 'includeProperties' instead.
- "IdAndTitle": Returns only the ID and Title of each item. This is the recommended default.
- "CoreDetails": Returns the main properties, excluding verbose security and link-related information.
- "AllDetails": Returns all available properties for each item. Only select "AllDetails" if you absolutely need full details about the returned items.`),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response. If used, the 'details' parameter is ignored. 'Id', 'Title', and '$type' will always be included.`),
    },
    execute: async ({ details = "IdAndTitle", includeProperties }: { details?: "IdAndTitle" | "CoreDetails" | "AllDetails", includeProperties?: string[] }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const hasCustomProperties = includeProperties && includeProperties.length > 0;
            const apiDetails = hasCustomProperties || details === 'CoreDetails' || details === 'AllDetails'
                ? 'Contentless'
                : 'IdAndTitleOnly';

            const response = await authenticatedAxios.get('/publications', {
                params: { details: apiDetails }
            });

            if (response.status === 200) {
                const finalData = filterResponseData({ responseData: response.data, details, includeProperties });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(finalData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve publications");
        }
    }
};