import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getMultimediaTypes = {
    name: "getMultimediaTypes",
    summary: "Retrieves a list of all Multimedia Types available in the system (Id, Title).",
    description: `Retrieves a list of all Multimedia Types available in the system (Id, Title).
    Multimedia Types define allowed file extensions and MIME types.
    
    ### "Find-Then-Fetch" Pattern
    1.  **Find:** Use this tool to get the list of Multimedia Type IDs.
    2.  **Fetch:** Use the 'toolOrchestrator' to call 'getItem' on specific IDs to check properties like 'FileExtensions' or 'MimeType'.`,
    input: {
        maxId: z.number().int().optional().default(200)
            .describe("The maximum ID to scan for. The tool will check for Multimedia Types with IDs from tcm:0-1-65544 up to this value."),
    },
    execute: async ({ maxId = 200 }: { maxId?: number }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            // Generate an array of potential Multimedia Type IDs to check.
            const potentialIds = [];
            for (let i = 1; i <= maxId; i++) {
                potentialIds.push(`tcm:0-${i}-65544`);
            }

            // Use the bulkRead endpoint to efficiently check which of the potential IDs exist.
            const response = await authenticatedAxios.post(
                `/items/bulkRead`,
                potentialIds,
                {
                    params: {
                        // We still need loadFullItems=true internally to verify existence and get the basic object
                        // but we will filter the output before returning it to the agent.
                        loadFullItems: true,
                    }
                }
            );

            if (response.status === 200) {
                // The response is a dictionary where keys are the found IDs.
                // We MUST filter out the "$type" string property or any non-object entries 
                // to ensure the result is a clean array of item objects.
                // We also filter out items that failed to load based on the API's LoadInfo.ErrorType.
                const foundItems = Object.values(response.data).filter((item: any) =>
                    typeof item === 'object' &&
                    item !== null &&
                    item.LoadInfo?.ErrorType !== 'Error'
                );

                const finalData = filterResponseData({
                    responseData: foundItems,
                    details: "IdAndTitle"
                });

                const formattedFinalData = formatForAgent(finalData);

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedFinalData, null, 2)
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve Multimedia Types`);
        }
    },
    examples: [
    ]
};