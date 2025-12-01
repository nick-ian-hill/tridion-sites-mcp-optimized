import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getPublications = {
    name: "getPublications",
    description: `Retrieves a list of all Publications (Id, Title and type).
    
    This is a primary discovery tool, as a Publication ID is often required by other tools like 'getCategories', 'getSchemaLinks', 'createRootStructureGroup', or to scope a query with the 'search' tool.
    
    ### "Find-Then-Fetch" Pattern
    This tool returns minimal identification data. It does **not** return deep properties like 'PublicationUrl', 'Parents', or 'MultimediaPath'.
    
    To inspect those details:
    1.  **Find:** Use this tool to get the Publication ID(s).
    2.  **Fetch:** Use 'getItem' (for a single publication) or 'toolOrchestrator' (for multiple) to retrieve specific properties.`,
    input: {},
    execute: async (_: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            const apiDetails = 'IdAndTitleOnly';

            const response = await authenticatedAxios.get('/publications', {
                params: { details: apiDetails }
            });

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    details: "IdAndTitle" 
                });
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
            return handleAxiosError(error, "Failed to retrieve publications");
        }
    }
};