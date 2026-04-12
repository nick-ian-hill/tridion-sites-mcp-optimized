import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const revertProcess = {
    name: "revertProcess",
    summary: "Terminates an active Workflow Process and discards all changes, resetting items to their pre-workflow state.",
    description: "Terminates an active Workflow Process and reverts all involved items back to the state they were in before the workflow started. This undoes any changes made during the workflow and removes the process entirely. Under the hood, this is achieved by deleting the Process Instance.",
    input: {
        processInstanceId: z.string().regex(/^tcm:\d+-\d+-131076$/)
            .describe("The unique ID of the workflow Process Instance to revert (e.g., 'tcm:1-2-131076'). Note: This must be the Process Instance ID, not an Activity Instance ID."),
    },
    execute: async ({ processInstanceId }: { processInstanceId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // Escape the TCM URI (replace ':' with '_') for the URL path
            const escapedProcessId = processInstanceId.replace(':', '_');
            const endpoint = `/items/${escapedProcessId}`;

            // Reverting a process is achieved by issuing a DELETE request to the Process Instance
            const response = await authenticatedAxios.delete(endpoint);

            // DELETE requests typically return 204 No Content on success, or 200.
            if (response.status === 204 || response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            type: "Success",
                            Id: processInstanceId,
                            Message: `Successfully reverted and deleted Workflow Process '${processInstanceId}'. All associated items have been reset to their pre-workflow state.`
                        }, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to revert Workflow Process '${processInstanceId}'`);
        }
    }
};