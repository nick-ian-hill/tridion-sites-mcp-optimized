import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";

const getTargetTypesInputProperties = {
    businessProcessTypeId: z.string().regex(/^tcm:\d+-\d+-4096$/, "Invalid Business Process Type ID. Expected 'tcm:X-X-4096'.").optional()
        .describe("The TCM URI of a Business Process Type. If provided, the list is filtered to only those Target Types available for publishing from this BPT. For a given publication, the value of the 'BusinessProcessType' property, if defined, is a 'Link' to a BPT."),
    details: z.enum(["IdAndTitle", "CoreDetails", "AllDetails"]).default("IdAndTitle").optional()
        .describe(`Specifies a predefined level of detail. 'IdAndTitle' is fastest. For custom properties, use 'includeProperties'.`),
    includeProperties: z.array(z.string()).optional()
        .describe(`The PREFERRED method for retrieving specific details. Provide property names (e.g., ["Purpose", "BusinessProcessType.Title"]). If used, 'details' is ignored. 'Id', 'Title', and '$type' are always included.`),
};

const getTargetTypesSchema = z.object(getTargetTypesInputProperties);

export const getTargetTypes = {
    name: "getTargetTypes",
    description: `Retrieves a list of Target Types. 
- If 'businessProcessTypeId' is provided, it returns only the publishable Target Types for that context. This is the **recommended** method when searching for a target to publish to.
- If omitted, it returns all Target Types defined in the system.`,

    input: getTargetTypesInputProperties,

    execute: async (input: z.infer<typeof getTargetTypesSchema>, context: any) => {
        const { 
            businessProcessTypeId, 
            details = "IdAndTitle", 
            includeProperties 
        } = input;

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
            
            // Neither API endpoint specified accepts query parameters for filtering,
            // so we fetch the full response and filter it locally.
            const response = await authenticatedAxios.get(endpoint);

            if (response.status === 200) {
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    details, 
                    includeProperties 
                });

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
            return handleAxiosError(error, `Failed to retrieve ${action}`);
        }
    }
};