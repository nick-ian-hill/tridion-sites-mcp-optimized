import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const getApprovalStatuses = {
    name: "getApprovalStatuses",
    summary: "Lists all Approval Statuses (e.g., 'Draft', 'Live') used to track item readiness in workflows.",
    description: `Retrieves a list of all Approval Statuses in the system. These statuses (e.g., 'Draft', 'Approved for Web') are used in workflows to indicate the current state of an item and determine if it meets the minimum requirements for publishing to certain targets.
    
    IMPORTANT: This tool returns the Id and Title of the requested statuses.
    
    ### "Find-Then-Fetch" Pattern
    To retrieve detailed information about specific approval statuses:
    1.  **Find:** Use this tool to get the list of approval status IDs.
    2.  **Fetch:** Use the 'toolOrchestrator' to pass these IDs to a 'mapScript' that calls 'getItem', or use 'bulkReadItems' in a toolOrchestrator preProcessingScript.`,
    input: {},
    execute: async (_args: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // Explicitly request the lowest detail level from the backend to save bandwidth
            const response = await authenticatedAxios.get('/approvalStatuses', {
                params: {
                    details: 'IdAndTitleOnly'
                }
            });

            if (response.status === 200) {
                // Ensure the output strictly conforms to the Id and Title pattern
                const finalData = filterResponseData({ 
                    responseData: response.data, 
                    details: "IdAndTitle" 
                });

                const formattedData = formatForAgent(finalData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve approval statuses");
        }
    }
};