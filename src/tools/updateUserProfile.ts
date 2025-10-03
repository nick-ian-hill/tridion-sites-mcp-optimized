import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { getLanguageId, getAvailableLanguages } from "../utils/languageUtils.js";

const favoriteLinkSchema = z.object({
    IdRef: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:.+)$/).describe("The unique ID of the favorite item."),
}).describe("A favorite item link. Only the IdRef is needed.");

const availableLanguages = getAvailableLanguages() as [string, ...string[]];

const updateUserProfileInput = z.object({
    userId: z.string().regex(/^tcm:0-\d+-65552$/).describe("The TCM URI of the user whose profile is to be updated (e.g., 'tcm:0-20-65552')."),
    favorites: z.array(favoriteLinkSchema).optional().describe("A complete array of favorite items. This will replace the user's entire existing list of favorites."),
    languageName: z.enum(availableLanguages).optional().describe("The new language for the user."),
    localeId: z.number().int().optional().describe("The new locale ID for the user (e.g., 13321 for English/United States with AM/PM)."),
    description: z.string().optional().describe("The new description for the user."),
    userProfileJson: z.string().optional().describe("ADVANCED: A JSON string representing the entire UserProfile object. If provided, this will completely replace the user's profile. This option overrides all other specific parameters.")
}).refine(data =>
    data.favorites !== undefined ||
    data.languageName !== undefined ||
    data.localeId !== undefined ||
    data.description !== undefined ||
    data.userProfileJson !== undefined, {
    message: "At least one update property (e.g., favorites, description) or the full 'userProfileJson' must be provided."
}).refine(data =>
    !(data.userProfileJson && (data.favorites !== undefined || data.languageName !== undefined || data.localeId !== undefined || data.description !== undefined)), {
    message: "When 'userProfileJson' is provided, other specific update parameters like 'favorites' or 'description' are not allowed."
});

type UpdateUserProfileInput = z.infer<typeof updateUserProfileInput>;

export const updateUserProfile = {
    name: "updateUserProfile",
    description: `Updates a user's profile preferences, such as their favorites list, language, and locale.
IMPORTANT: When updating favorites, this operation replaces the entire existing list with the new one you provide. To add or remove a single favorite, you should first use the 'getUserProfile' tool to get the current list, modify it, and then provide the complete, updated list to this tool.`,
    input: updateUserProfileInput,
    execute: async (params: UpdateUserProfileInput, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { userId, favorites, languageName, localeId, description, userProfileJson } = params;
        const restUserId = userId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            let userProfilePayload;

            if (userProfileJson) {
                try {
                    userProfilePayload = JSON.parse(userProfileJson);
                } catch (e) {
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    throw new Error(`The 'userProfileJson' parameter is not a valid JSON string. Details: ${errorMessage}`);
                }
            } else {
                const getProfileResponse = await authenticatedAxios.get(`/items/${restUserId}/profile`);
                if (getProfileResponse.status !== 200) {
                    return handleUnexpectedResponse(getProfileResponse);
                }
                userProfilePayload = getProfileResponse.data;

                if (favorites !== undefined) {
                    const newFavorites = favorites.map(fav => ({ "$type": "FavoriteLink", "IdRef": fav.IdRef }));
                    if (!userProfilePayload.Preferences) userProfilePayload.Preferences = { "$type": "UserPreferences" };
                    userProfilePayload.Preferences.Favorites = newFavorites;
                }

                if (languageName !== undefined && userProfilePayload.User) {
                    const languageId = getLanguageId(languageName);
                    if (languageId !== undefined) userProfilePayload.User.LanguageId = languageId;
                }

                if (localeId !== undefined && userProfilePayload.User) {
                    userProfilePayload.User.LocaleId = localeId;
                }

                if (description !== undefined && userProfilePayload.User) {
                    userProfilePayload.User.Description = description;
                }
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restUserId}/profile`, userProfilePayload);
            if (updateResponse.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully updated profile for user ${userId}.\n\n${JSON.stringify(updateResponse.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(updateResponse);
            }

        } catch (error) {
            return handleAxiosError(error, `Failed to update profile for user ${userId}`);
        }
    }
};