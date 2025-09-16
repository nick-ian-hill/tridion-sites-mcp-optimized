import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

// 1. Define input properties as a plain object.
const getComponentTemplateLinksInputProperties = {
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The TCM URI of the Schema."),
    onlyAllowedOnPage: z.boolean().optional().default(false).describe("If set to true, only (Dynamic) Component Templates which are Allowed On a Page are returned."),
};

// 2. Create the Zod schema from the properties object for type safety.
const getComponentTemplateLinksSchema = z.object(getComponentTemplateLinksInputProperties);

export const getComponentTemplateLinks = {
    name: "getComponentTemplateLinks",
    description: "Gets a list of all Component Template links that can render Components based on the specified Schema.",

    // 3. Export the PLAIN object for VS Code tooling.
    input: getComponentTemplateLinksInputProperties,

    // 4. Use z.infer for the execute function's input type.
    execute: async (input: z.infer<typeof getComponentTemplateLinksSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { schemaId, onlyAllowedOnPage = false } = input;
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
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