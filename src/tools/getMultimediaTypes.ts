import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getMultimediaTypes = {
    name: "getMultimediaTypes",
    description: `Retrieves a list of all Multimedia Types available in the system. Multimedia Types define allowed file extensions and MIME types (e.g., 'jpeg', 'pdf') and are used in Multimedia Schemas to restrict uploads. Since there is no direct API to list them, this tool attempts to load them by checking for commonly used IDs.

Example:
Find all multimedia types and return only their file extensions and MIME types.

    const result = await tools.getMultimediaTypes({
        includeProperties: ["FileExtensions", "MimeType"]
    });

Expected JSON Output for a single item in the result array:
[
  {
    "type": "MultimediaType",
    "Id": "tcm:0-4-65544",
    "Title": "Word document",
    "FileExtensions": [
      "doc"
    ],
    "MimeType": "application/msword"
  }
]`,
    input: {
        maxId: z.number().int().optional().default(200)
            .describe("The maximum ID to scan for. The tool will check for Multimedia Types with IDs from tcm:0-1-65544 up to this value."),
        includeProperties: z.array(z.string()).optional()
            .describe("An array of property names to include in the response for each Multimedia Type. 'Id', 'Title', and 'type' will always be included. Common useful properties are 'FileExtensions' and 'MimeType'."),
    },
    execute: async ({ maxId = 200, includeProperties }: { 
        maxId?: number; 
        includeProperties?: string[] 
    }, context: any) => {
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
                        // We need the full item details to get the MultimediaType properties.
                        loadFullItems: true,
                    }
                }
            );

            if (response.status === 200) {
                // The response is a dictionary where keys are the found IDs.
                // We extract the values to get an array of the Multimedia Type objects.
                const foundItems = Object.values(response.data);

                // Apply property filtering if requested.
                const finalData = filterResponseData({ responseData: foundItems, includeProperties });
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
    }
};