import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getItemById = {
    name: "getItemById",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item using its unique ID.
For versioned item types (Components, Component Templates, Pages, Page Templates, Template Building Blocks and Schemas), set useDynamicVersion to true to get the most recent saved data, including any revisions made since the last major version.
The returned details typically include item type ($type), title (Title), content fields (Content), and metadata fields (Metadata).
This tool cannot modify, update, or delete any CMS items or files.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
        useDynamicVersion: z.boolean().optional().default(false).describe("Set to true for versioned items to get the most recent saved data, including minor revisions since the last major version."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details. Provide an array of property names to include in the response. 'Id', 'Title', and '$type' will always be included.`)
    },
    execute: async ({ itemId, useDynamicVersion = false, includeProperties }: { 
        itemId: string, 
        useDynamicVersion?: boolean,
        includeProperties?: string[] 
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');
            const params: { useDynamicVersion?: boolean } = {};

            if (useDynamicVersion) {
                params.useDynamicVersion = true;
            }

            const response = await authenticatedAxios.get(`/items/${restItemId}`, { params });

            if (response.status === 200) {
                const finalData = filterResponseData({ responseData: response.data, includeProperties });
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
            return handleAxiosError(error, "Failed to authenticate or retrieve item");
        }
    }
};