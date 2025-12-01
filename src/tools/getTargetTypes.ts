import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getTargetTypesInputProperties = {
    businessProcessTypeId: z.string().regex(/^tcm:\d+-\d+-4096$/, "Invalid Business Process Type ID. Expected 'tcm:X-X-4096'.").optional()
        .describe("The TCM URI of a Business Process Type. If provided, the list is filtered to only those Target Types available for publishing from this BPT."),
};

const getTargetTypesSchema = z.object(getTargetTypesInputProperties);

export const getTargetTypes = {
    name: "getTargetTypes",
    description: `Retrieves a list of Target Types (Id, Title, type).
    
    This is the **recommended** method when searching for a target to publish to.
    
    ### "Find-Then-Fetch" Pattern
    To inspect specific properties (e.g., 'Purpose', 'BusinessProcessType.Title):
    1.  **Find:** Use this tool to get the list of Target Type IDs.
    2.  **Fetch:** Use the 'toolOrchestrator' to call 'getItem' for specific details.`,

    input: getTargetTypesInputProperties,

    execute: async (input: z.infer<typeof getTargetTypesSchema>, context: any) => {
        const { businessProcessTypeId } = input;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        let endpoint: string;
        let action: string;

        if (businessProcessTypeId) {
            const restBptId = businessProcessTypeId.replace(':', '_');
            endpoint = `/items/${restBptId}/publishableTargetTypes`;
            action = `publishable Target Types for ${businessProcessTypeId}`;
        } else {
            endpoint = '/targetTypes';
            action = "all Target Types";
        }

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const response = await authenticatedAxios.get(endpoint);

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
            return handleAxiosError(error, `Failed to retrieve ${action}`);
        }
    }
};