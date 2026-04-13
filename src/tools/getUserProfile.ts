import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { getLanguageName } from "../utils/languageUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

export const getUserProfile = {
    name: "getUserProfile",
    summary: "Retrieves the profile and preferences of a specific user or the current user.",
    description: `Retrieves the profile of a specific user or the currently logged-in user. User profiles contain information like display name, preferences (including favorites), and system runtime details. The tool automatically adds a 'LanguageName' field if a 'LanguageId' is present.`,
    input: {
        userId: z.string().regex(/^tcm:0-\d+-65552$/).optional().describe("The TCM URI of the user (e.g., 'tcm:0-20-65552'). If omitted, the profile of the currently logged-in user is retrieved."),
        includeProperties: z.array(z.string()).optional().describe(`An array of property names to include in the response object (e.g., ["DisplayName", "User.Title", "User.IsEnabled", "User.LanguageName", "Preferences.Favorites", "Runtime.IsAdministrator"]).`)
    },
    execute: async ({ userId, includeProperties }: { userId?: string, includeProperties?: string[] }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            let response;
            if (userId) {
                const restUserId = userId.replace(':', '_');
                response = await authenticatedAxios.get(`/items/${restUserId}/profile`);
            } else {
                response = await authenticatedAxios.get('/whoAmI');
            }

            if (response.status === 200) {
                const profileData = response.data;

                // Add LanguageName if LanguageId exists in the nested User object
                if (profileData?.User?.LanguageId) {
                    const langName = getLanguageName(profileData.User.LanguageId);
                    if (langName) {
                        profileData.User.LanguageName = langName;
                    }
                }

                const finalData = filterResponseData({ responseData: profileData, includeProperties });
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
            const contextMessage = userId ? `Failed to retrieve profile for user ${userId}` : "Failed to retrieve current user's profile";
            return handleAxiosError(error, contextMessage);
        }
    },
    examples: [
    ]
};