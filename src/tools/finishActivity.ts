import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { toLink } from "../utils/links.js";
import { formatForAgent } from "../utils/fieldReordering.js";
import { filterResponseData } from "../utils/responseFiltering.js";

export const finishActivity = {
    name: "finishActivity",
    description: `Finishes a workflow activity that is in 'Assigned' or 'Started' state. This moves the workflow to the next step, if one is defined. Automatically handles both standard activities and decision activities by inspecting the activity's definition.
    
IMPORTANT BUSINESS RULE: When a workflow process completes fully, the process and all its activities are converted into "histories". Their URIs mutate:
- Process Instances (ending in '-131076') become Process Histories (ending in '-131080').
- Activity Instances (ending in '-131104') become Activity Histories (ending in '-131136').

This tool returns a 'FinishActivityResult'. If 'NextActivityInstance' is absent, this was the terminal step — the process is complete and history IDs are available immediately via 'getItem'. The 'WorkflowHistoryHint' in the response will contain the exact IDs to use. Otherwise, the workflow is still active and no history IDs are provided.`,
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
    },    
    execute: async ({ 
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
                // Safely filter the returned state data
                const filteredData = filterResponseData({
                    responseData: response.data,
                    details: "CoreDetails" 
                });
                const formattedResponseData = formatForAgent(filteredData);
                
                const isTerminalStep = !response.data.NextActivityInstance;

                const responsePayload: Record<string, unknown> = {
                    Message: `Successfully finished activity '${activityId}'.`,
                    Data: formattedResponseData
                };

                if (isTerminalStep) {
                    const activityHistoryId = activityId.replace('-131104', '-131136');
                    let historyNote = `Process complete. Activity History ID: ${activityHistoryId}`;
                    if (activityInstance.Process?.IdRef) {
                        const processHistoryId = activityInstance.Process.IdRef.replace('-131076', '-131080');
                        historyNote += `, Process History ID: ${processHistoryId}`;
                    }
                    responsePayload.WorkflowHistoryHint = historyNote;
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responsePayload, null, 2)
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