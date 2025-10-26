import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getItem = {
    name: "getItem",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item. This is a foundational tool used to gather information before performing other actions.
Common uses include:
- Inspecting a Schema or Page Template's structure before using 'createItem' or 'createPage'.
- Checking an item's 'LockInfo' before attempting to update it with tools like 'updateContent' or 'updateMetadata'.
- Checking an item's 'BluePrintInfo' before using BluePrinting tools like 'localizeItem' or 'promoteItem'.
For retrieving multiple items, the 'bulkReadItems' tool is more efficient.
For versioned item types (Components, Component Templates, Pages, Page Templates, Template Building Blocks and Schemas), set useDynamicVersion to true to get the most recent saved data, including any revisions made since the last major version.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
        useDynamicVersion: z.boolean().optional().default(false).describe("Set to true for versioned items to get the most recent saved data, including minor revisions since the last major version."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details, e.g., ['BluePrintInfo', 'Schema.IdRef', 'VersionInfo.RevisionDate', 'VersionInfo.Revisor.IdRef', 'ActivityDefinition']. 'Id', 'Title', and '$type' will always be included. Use this if you are sure how to reference the properties you are interested in for the requested item type.`)
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