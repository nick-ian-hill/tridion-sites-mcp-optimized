import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { toLink } from "../utils/links.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const finishActivity = {
    name: "finishActivity",
    description: "Finishes a workflow activity that is in 'Assigned' or 'Started' state. This moves the workflow to the next step, if one is defined. Automatically handles both standard activities and decision activities by inspecting the activity's definition.",
    input: {
        activityId: z.string().regex(/^tcm:\d+-\d+-131104$/)
            .describe("The unique ID of the workflow activity instance to finish (e.g., 'tcm:1-2-131104'). Use 'getActivities' to find the ID."),
        nextActivityDefinitionId: z.string().regex(/^tcm:\d+-\d+-131088$/).optional()
            .describe("REQUIRED only for decision activities. The ID of the chosen next activity definition (e.g., 'tcm:5-28-131088' for 'Accept'). If this is omitted for a decision activity, the tool will return an error listing the available options."),
        comment: z.string().optional()
            .describe("An optional comment to add to the workflow history, explaining the action taken."),
        nextAssigneeId: z.string().regex(/^tcm:\d+-\d+-65552$/)
            .optional()
            .describe("The ID of the user to assign the next activity to. Use 'getUsers' to find a user ID."),
        nextActivityDueDate: z.string().datetime({ message: "Invalid ISO 8601 datetime format." })
            .optional()
            .describe("An optional due date for the next activity in ISO 8601 format (e.g., '2025-12-31T17:00:00Z')."),
    },    execute: async ({ 
        activityId, 
        nextActivityDefinitionId,
        comment, 
        nextAssigneeId, 
        nextActivityDueDate 
    }: {
        activityId: string;
        nextActivityDefinitionId?: string;
        comment?: string;
        nextAssigneeId?: string;
        nextActivityDueDate?: string;
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedActivityId = activityId.replace(':', '_');
            
            // 1. Get the Activity Instance to inspect its definition
            const instanceResponse = await authenticatedAxios.get(`/items/${escapedActivityId}`);
            const activityInstance = instanceResponse.data;

            const activityDefinitionId = activityInstance?.ActivityDefinition?.IdRef;
            if (!activityDefinitionId) {
                throw new Error(`Could not find ActivityDefinition link in Activity Instance '${activityId}'.`);
            }

            // 2. Get the Activity Definition to check its type
            const escapedDefinitionId = activityDefinitionId.replace(':', '_');
            const definitionResponse = await authenticatedAxios.get(`/items/${escapedDefinitionId}`);
            const activityDefinition = definitionResponse.data;

            let requestModel;
            const endpoint = `/items/${escapedActivityId}/finishActivity`;

            // 3. Determine the correct request model based on ActivityType
            if (activityDefinition?.ActivityType === "Decision") {
                if (!nextActivityDefinitionId) {
                    // If it's a decision but no choice was made, return a helpful error
                    const availableOptions = activityDefinition.NextActivityDefinitions.map((def: any) => ({ title: def.Title, id: def.IdRef }));
                    const errorMessage = `This is a decision activity. You must provide a 'nextActivityDefinitionId'. Available options: ${JSON.stringify(availableOptions)}`;
                    return handleAxiosError(new Error(errorMessage), `Missing required parameter for decision activity '${activityId}'`);
                }
                requestModel = {
                    "$type": "DecisionActivityFinishRequest",
                    NextActivity: toLink(nextActivityDefinitionId),
                    Message: comment,
                };
            } else {
                // It's a standard activity
                requestModel = {
                    "$type": "ActivityFinishRequest",
                    Message: comment,
                    NextAssignee: toLink(nextAssigneeId),
                    NextActivityDueDate: nextActivityDueDate,
                };
            }

            // 4. Send the request to finish the activity
            const response = await authenticatedAxios.post(endpoint, requestModel);

            if (response.status === 200) {
                const formattedResponseData = formatForAgent(response.data);
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
            return handleAxiosError(error, `Failed to finish activity '${activityId}'`);
        }
    }
};