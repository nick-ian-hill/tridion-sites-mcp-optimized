import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getActivities = {
    name: "getActivities",
    summary: "Lists workflow activities (tasks) filtered by user and state (e.g., 'Assigned', 'Failed').",
    description: `Gets a list of workflow activities, which can be filtered by user and state.
    
    IMPORTANT: This tool returns the Id and Title of the requested activities.
    
    ### "Find-Then-Fetch" Pattern
    To retrieve detailed information about specific activities (e.g., to generate a report of all "Suspended" activities and their error messages):
    1.  **Find:** Use this tool to get the list of activity IDs.
    2.  **Fetch:** Use the 'toolOrchestrator' to pass these IDs to a 'mapScript' that calls 'getItem', or use 'bulkReadItems' in a toolOrchestrator preProcessingScript.`,
    input: {
        userId: z.string().regex(/^tcm:0-\d+-65552$/).optional()
            .describe("The TCM URI of a user. If specified, the tool returns activities where this user is either the owner or the assignee. The 'getUsers' tool can be used to find user IDs."),
        activityStates: z.array(z.enum([
                "Assigned", 
                "Started", 
                "Finished", 
                "Suspended", 
                "Failed", 
                "WaitingForWorkflowAgent"
            ]))
            .optional()
            .default(['Assigned'])
            .describe("An array of activity states to filter the results. Defaults to ['Assigned']."),
    },
    execute: async ({ userId, activityStates = ['Assigned'] }: { 
        userId?: string, 
        activityStates?: ("Assigned" | "Started" | "Finished" | "Suspended" | "Failed" | "WaitingForWorkflowAgent")[]
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
            return handleAxiosError(error, "Failed to retrieve workflow activities");
        }
    }
};