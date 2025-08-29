import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

// Define the allowed SchemaPurpose values based on the spec, excluding "UnknownByClient".
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
    description: "Gets a list of all Schema links contained within a specified Publication, filtered by one or more purposes. This tool can be used when looking for candidate schemas for a new Component or Multimedia Component.",
    input: {
        publicationId: z.string().regex(/^tcm:0-\d+-1$/).describe("The TCM URI of the Publication to search within (e.g., 'tcm:0-5-1')."),
        schemaPurpose: z.array(schemaPurposeEnum).nonempty().describe("An array of one or more Schema purposes to filter the results.")
    },
    execute: async ({ publicationId, schemaPurpose }: { publicationId: string, schemaPurpose: string[] }) => {
        try {
            // The API requires the colon in the ID to be replaced with an underscore for the path parameter.
            const escapedPublicationId = publicationId.replace(':', '_');

            const response = await authenticatedAxios.get(`/items/${escapedPublicationId}/schemaLinks`, {
                params: {
                    schemaPurpose // Axios handles serializing the array into multiple query parameters.
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