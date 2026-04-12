import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const forceFinishProcess = {
    name: "forceFinishProcess",
    summary: "Abruptly terminates a Workflow Process and applies a final Approval Status to all items.",
    description: `Force finishes a Workflow Process. This abruptly terminates the workflow process and skips any remaining activities. You must specify an Approval Status to apply to all items within the workflow upon termination.
    
IMPORTANT BUSINESS RULE: When a process completes, the process and all its associated activities are converted into "histories". Their URIs will mutate:
- Process Instances (ending in '-131076') become Process Histories (ending in '-131080').
- Activity Instances (ending in '-131104') become Activity Histories (ending in '-131136').
The tool will return the new, actual History ID. You must use this new History ID with the 'getItem' tool if you need to read the workflow's final state.`,
    input: {
        instanceId: z.string().regex(/^tcm:\d+-\d+-(131076|131104)$/)
            .describe("The TCM URI of the Process Instance (ends in '-131076') or an Activity Instance (ends in '-131104') that is part of the process you want to finish."),
        approvalStatusId: z.string().regex(/^tcm:0-\d+-\d+$/)
            .describe("The TCM URI of the Approval Status to apply to all items in the Workflow Process (e.g., 'tcm:0-7-131089'). Use the 'getApprovalStatuses' tool to find a valid ID."),
    },
    execute: async ({ 
        instanceId, 
        approvalStatusId 
    }: { 
        instanceId: string; 
        approvalStatusId: string; 
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedInstanceId = instanceId.replace(':', '_');
            const endpoint = `/items/${escapedInstanceId}/forceFinishProcess`;

            // Request the full history to capture the ground-truth ID, enforcing find-then-fetch
            const response = await authenticatedAxios.post(endpoint, null, {
                params: {
                    approvalStatusId: approvalStatusId,
                    returnFullProcessHistory: true 
                }
            });

            if (response.status === 200) {
                const actualHistoryId = response.data.Id;

                const filteredData = filterResponseData({
                    responseData: response.data,
                    details: "IdAndTitle" 
                });
                
                const formattedData = formatForAgent(filteredData);
                
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            Message: `Workflow forcefully finished and converted to a history state.`,
                            WorkflowHistoryHint: `To retrieve full details, use the 'getItem' tool with the actual History ID: ${actualHistoryId}`,
                            Data: formattedData
                        }, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to force finish process for instance '${instanceId}'`);
        }
    }
};