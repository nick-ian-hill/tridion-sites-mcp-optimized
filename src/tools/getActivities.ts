import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getActivities = {
    name: "getActivities",
    description: `Gets a list of workflow activities, which can be filtered by user and state. This is useful for finding tasks assigned to a specific user or for reviewing all activities in a particular state (e.g., 'Suspended').
    Consider using this tool in combination with the toolOrchestrator to ensure the response does not 'pollute' the context window.`,
    input: {
        userId: z.string().regex(/^tcm:0-\d+-65552$/).optional()
            .describe("The TCM URI of a user. If specified, the tool returns activities where this user is either the owner or the assignee. The 'getUsers' tool can be used to find user IDs."),
        activityStates: z.array(z.enum([
                "Assigned", 
                "Started", 
                "Finished", 
                "Suspended", 
                "Failed", 
                "Aborted"
            ]))
            .optional()
            .default(['Assigned'])
            .describe("An array of activity states to filter the results. Defaults to ['Assigned']."),
        includeProperties: z.array(z.string()).optional()
            .describe(`The PREFERRED method for retrieving specific details. Provide property names (e.g., ["Assignee.IdRef", "Assignee.Title", "Assignee.Description", "Process.IdRef", "PrimarySubject.Title"]). 'Id', 'Title', and 'type' are always included. Refer to the 'getItem' tool description for a comprehensive list of available properties.`),
    },
    execute: async ({ userId, activityStates = ['Assigned'], includeProperties }: { 
        userId?: string, 
        activityStates?: ("Assigned" | "Started" | "Finished" | "Suspended" | "Failed" | "Aborted")[],
        includeProperties?: string[]
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // Prepare the query parameters for the API call
            const params: {
                ownerId?: string;
                assigneeId?: string;
                forAllUsers?: boolean;
                activityStates: string[];
            } = {
                activityStates: activityStates,
            };

            if (userId) {
                // If a user ID is provided, search for activities owned by or assigned to that user.
                params.ownerId = userId;
                params.assigneeId = userId;
            } else {
                // Otherwise, search for activities for all users.
                params.forAllUsers = true;
            }

            const response = await authenticatedAxios.get('/activityInstances', { params });

            if (response.status === 200) {
                const finalData = filterResponseData({
                    responseData: response.data,
                    includeProperties: includeProperties
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
            return handleAxiosError(error, "Failed to retrieve workflow activities");
        }
    }
};