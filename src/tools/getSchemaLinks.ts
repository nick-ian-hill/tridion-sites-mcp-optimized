import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

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
    description: "Gets a list of all Schema links contained within a specified Publication, filtered by one or more purposes. This tool should be used in preference to search when looking for candidate schemas/metadata schema for a new item (e.g., Component).",
    input: {
        publicationId: z.string().regex(/^tcm:0-\d+-1$/).describe("The TCM URI of the Publication to search within (e.g., 'tcm:0-5-1')."),
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
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
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