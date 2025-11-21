import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getItem = {
    name: "getItem",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item.
This is the primary tool for "fetching" the FULL data of an item, including its 'Content' and 'Metadata' (values), and 'BinaryContent' (MimeType, Size), after it has been "found" by a search or list tool.
Common uses include:
- Inspecting a Schema or Page Template's structure before using 'createComponent', 'createItem', or 'createPage'.
- Checking an item's 'LockInfo' before attempting to update it with tools like 'updateContent' or 'updateMetadata'.
- Checking an item's 'BluePrintInfo' before using BluePrinting tools like 'localizeItem' or 'promoteItem'.
For retrieving multiple items, the 'bulkReadItems' tool is more efficient.
For versioned item types (Components, Component Templates, Pages, Page Templates, Template Building Blocks and Schemas), this tool returns the most recent saved data (dynamic version) by default.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
        useDynamicVersion: z.boolean().optional().default(true).describe("Defaults to true. For versioned items (Components, Pages, Templates, Schemas), this retrieves the latest saved state (dynamic version), including minor revisions and checked-out changes. Set to false to strictly retrieve the last checked-in major version. This parameter is ignored for non-versioned items."),
        includeProperties: z.array(z.string()).optional().describe(`The PREFERRED method for retrieving specific details, e.g., ['BluePrintInfo', 'BluePrintInfo.OwningRepository', 'IsPublishedInContext', 'Schema.IdRef', 'VersionInfo.RevisionDate', 'VersionInfo.Revisor.IdRef', 'ActivityDefinition', 'Content', 'Metadata', 'BinaryContent.MimeType']. 'Id', 'Title', and 'type' will always be included. Use this if you are sure how to reference the properties you are interested in for the requested item type.`)
    },
    execute: async ({ itemId, useDynamicVersion = true, includeProperties }: { 
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
            return handleAxiosError(error, "Failed to authenticate or retrieve item");
        }
    }
};