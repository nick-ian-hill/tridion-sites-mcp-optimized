import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const getActivities = {
    name: "getActivities",
    description: "Gets a list of workflow activities, which can be filtered by user and state. This is useful for finding tasks assigned to a specific user or for reviewing all activities in a particular state (e.g., 'Suspended').",
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
    },
    execute: async ({ userId, activityStates = ['Assigned'] }: { 
        userId?: string, 
        activityStates?: ("Assigned" | "Started" | "Finished" | "Suspended" | "Failed" | "Aborted")[]
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
            return handleAxiosError(error, "Failed to retrieve workflow activities");
        }
    }
};