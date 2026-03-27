import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const forceFinishProcess = {
    name: "forceFinishProcess",
    description: "Force finishes a Workflow Process. This abruptly terminates the workflow process and skips any remaining activities. You must specify an Approval Status to apply to all items within the workflow upon termination.",
    input: {
        instanceId: z.string().regex(/^tcm:\d+-\d+-(131076|131104)$/)
            .describe("The TCM URI of the Process Instance (ends in '-131076') or an Activity Instance (ends in '-131104') that is part of the process you want to finish."),
        approvalStatusId: z.string().regex(/^tcm:0-\d+-\d+$/)
            .describe("The TCM URI of the Approval Status to apply to all items in the Workflow Process (e.g., 'tcm:0-7-131089'). Use the 'getApprovalStatuses' tool to find a valid ID."),
        returnFullProcessHistory: z.boolean()
            .optional()
            .default(false)
            .describe("If set to true, returns the full Process History created by finishing the workflow. If false (the default), only its identifier is returned."),
    },
    execute: async ({ 
        instanceId, 
        approvalStatusId, 
        returnFullProcessHistory = false 
    }: { 
        instanceId: string; 
        approvalStatusId: string; 
        returnFullProcessHistory?: boolean; 
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // Escape the TCM URI (replace ':' with '_') for the URL path
            const escapedInstanceId = instanceId.replace(':', '_');
            const endpoint = `/items/${escapedInstanceId}/forceFinishProcess`;

            // Note: The spec defines these parameters as query parameters, not body payload.
            const response = await authenticatedAxios.post(endpoint, null, {
                params: {
                    approvalStatusId: approvalStatusId,
                    returnFullProcessHistory: returnFullProcessHistory
                }
            });

            if (response.status === 200) {
                const formattedData = formatForAgent(response.data);
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
            return handleAxiosError(error, `Failed to force finish process for instance '${instanceId}'`);
        }
    }
};