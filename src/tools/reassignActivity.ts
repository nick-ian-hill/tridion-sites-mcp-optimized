import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const reassignActivity = {
    name: "reassignActivity",
    summary: "Reassigns a workflow activity to a different user or group.",
    description: "Reassigns a workflow activity to a different user or group. The activity must be in a state that allows reassignment (e.g., 'Assigned' or 'Started'). Use 'getUsers' to find the ID of the new assignee.",
    input: {
        activityId: z.string().regex(/^tcm:\d+-\d+-131104$/)
            .describe("The unique ID of the workflow activity instance to reassign (e.g., 'tcm:1-2-131104')."),
        newAssigneeId: z.string().regex(/^tcm:\d+-\d+-(65552|65568)$/)
            .describe("The TCM URI of the User (type 65552) or Group (type 65568) to reassign this activity to."),
    },
    execute: async ({ activityId, newAssigneeId }: {
        activityId: string;
        newAssigneeId: string;
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedActivityId = activityId.replace(':', '_');
            const endpoint = `/items/${escapedActivityId}/reassignActivity`;

            const response = await authenticatedAxios.post(endpoint, null, {
                params: {
                    newAssigneeId: newAssigneeId
                }
            });

            if (response.status === 200) {
                const responseData = {
                    type: "Success",
                    Id: activityId,
                    NewAssigneeId: newAssigneeId,
                    Message: `Activity ${activityId} successfully reassigned to ${newAssigneeId}`
                };
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to reassign activity '${activityId}'`);
        }
    }
};