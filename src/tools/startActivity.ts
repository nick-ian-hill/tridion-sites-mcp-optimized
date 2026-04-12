import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const startActivity = {
    name: "startActivity",
    summary: "Starts a workflow activity that is currently in 'Assigned' state.",
    description: "Starts a specified workflow activity. The activity must be in an 'Assigned' state before it can be started. Use the 'getActivities' tool to find the ID of an activity.",
    input: {
        activityId: z.string().regex(/^tcm:\d+-\d+-131104$/)
            .describe("The unique ID of the workflow activity instance to start."),
    },
    execute: async ({ activityId }: { activityId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedActivityId = activityId.replace(':', '_');
            const endpoint = `/items/${escapedActivityId}/startActivity`;
            
            const response = await authenticatedAxios.post(endpoint);

            if (response.status === 200) {
                const responseData = {
                    type: response.data['$type'],
                    Id: response.data.Id,
                    Message: `Successfully started ${response.data.Id}`,
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
            return handleAxiosError(error, `Failed to start activity '${activityId}'`);
        }
    }
};