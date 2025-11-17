import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getProcessDefinitions = {
    name: "getProcessDefinitions",
    description: `Retrieves the list of available workflow process definitions for a specified publication. A process definition's ID is required to start a new workflow process for an item.`,
    input: {
        publicationId: z.string().regex(/^tcm:0-[1-9]\d*-1$/).describe("The unique ID of a Publication (e.g., 'tcm:0-5-1'). Use the 'getPublications' tool to find a Publication ID."),
    },
    execute: async ({ publicationId }: { publicationId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedPublicationId = publicationId.replace(':', '_');
            const endpoint = `/items/${escapedPublicationId}/processDefinitions`;
            const response = await authenticatedAxios.get(endpoint);

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
            return handleAxiosError(error, `Failed to retrieve process definitions for publication '${publicationId}'`);
        }
    }
};