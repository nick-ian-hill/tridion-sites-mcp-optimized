import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

const getComponentTemplateLinksInputProperties = {
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The TCM URI of the Schema. Use 'getSchemaLinks' or 'search' to find a Schema ID."),
    onlyAllowedOnPage: z.boolean().optional().default(false).describe("If set to true, only (Dynamic) Component Templates which are Allowed On a Page are returned."),
};

const getComponentTemplateLinksSchema = z.object(getComponentTemplateLinksInputProperties);

export const getComponentTemplateLinks = {
    name: "getComponentTemplateLinks",
    summary: "Lists Component Templates compatible with a specific Schema.",
    description: "Gets a list of all Component Template links that can render Components based on the specified Schema. Note that this tool returns a list of Link objects (containing 'IdRef' and 'Title'), unlike other tools that typically return an 'Id'. This is useful when constructing the 'componentPresentations' parameter for the 'createPage' or 'updatePage' tools, as it helps identify which Component Templates are compatible with a given Component (Schema) type.",

    input: getComponentTemplateLinksInputProperties,

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
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    includeProperties: ["IdRef"] 
                });

                const formattedResponseData = formatForAgent(finalData);
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
            return handleAxiosError(error, `Failed to retrieve component template links for schema '${schemaId}'`);
        }
    }
};