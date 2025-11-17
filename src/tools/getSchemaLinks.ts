import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const schemaPurposeEnum = z.enum([
    "Component",
    "Multimedia",
    "Embedded",
    "Metadata",
    "Protocol",
    "VirtualFolderType",
    "TemplateParameters",
    "Bundle",
    "Region"
]);

export const getSchemaLinks = {
    name: "getSchemaLinks",
    description: "Gets a list of all Schema links within a Publication, filtered by purpose. This tool is useful for finding the available schemas when creating an item or changing an item's metadata schema. For example, use it to find a 'Component' schema before calling 'createComponent', a 'Region' schema before calling 'createRegionSchema', or a 'Metadata' schema before calling 'updateItemProperties'.",
    input: {
        publicationId: z.string().regex(/^tcm:0-\d+-1$/).describe("The TCM URI of the Publication to search within (e.g., 'tcm:0-5-1'). Use 'getPublications' to find a Publication ID."),
        schemaPurpose: z.array(schemaPurposeEnum).nonempty().describe("An array of one or more Schema purposes to filter the results.")
    },
    execute: async ({ publicationId, schemaPurpose }: { publicationId: string, schemaPurpose: string[] }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedPublicationId = publicationId.replace(':', '_');

            const response = await authenticatedAxios.get(`/items/${escapedPublicationId}/schemaLinks`, {
                params: {
                    schemaPurpose
                }
            });

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
            return handleAxiosError(error, "Failed to retrieve Schema links");
        }
    }
};