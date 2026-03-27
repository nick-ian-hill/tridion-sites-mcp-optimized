import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const restartActivity = {
    name: "restartActivity",
    description: "Restarts an automated workflow Activity Instance that is currently in a 'Failed' state. This is highly useful for re-triggering automated scripts or system tasks that failed due to transient issues without having to restart the entire workflow process.",
    input: {
        activityId: z.string().regex(/^tcm:\d+-\d+-131104$/)
            .describe("The unique ID of the failed workflow Activity Instance to restart (e.g., 'tcm:1-2-131104'). Use the 'getActivities' tool (with the 'Failed' state filter) to find the correct ID."),
    },
    execute: async ({ activityId }: { activityId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // Escape the TCM URI (replace ':' with '_') for the URL path
            const escapedActivityId = activityId.replace(':', '_');
            const endpoint = `/items/${escapedActivityId}/restartActivity`;

            const response = await authenticatedAxios.post(endpoint);

            if (response.status === 200) {
                // The API returns the updated ActivityInstance
                const formattedData = formatForAgent(response.data);
                
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            Message: `Successfully restarted activity '${activityId}'. The activity should now be processing again.`,
                            ActivityDetails: formattedData
                        }, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to restart activity '${activityId}'`);
        }
    }
};