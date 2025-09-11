import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getComponentTemplateLinks = {
    name: "getComponentTemplateLinks",
    description: "Gets a list of all Component Template links that can render Components based on the specified Schema.",
    input: {
        schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The TCM URI of the Schema."),
        onlyAllowedOnPage: z.boolean().optional().default(false).describe("If set to true, only (Dynamic) Component Templates which are Allowed On a Page are returned."),
    },
    execute: async ({ schemaId, onlyAllowedOnPage = false }: {
        schemaId: string,
        onlyAllowedOnPage?: boolean
    }) => {
        try {
            const escapedSchemaId = schemaId.replace(':', '_');
            const endpoint = `/items/${escapedSchemaId}/componentTemplateLinks`;
            
            const response = await authenticatedAxios.get(endpoint, {
                params: {
                    onlyAllowedOnPage: onlyAllowedOnPage,
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
            return handleAxiosError(error, `Failed to retrieve component template links for schema '${schemaId}'`);
        }
    }
};
