import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { getLanguageId, getAvailableLanguages } from "../utils/languageUtils.js";

const favoriteLinkSchema = z.object({
    IdRef: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the favorite item."),
}).describe("A favorite item link. Only the IdRef is needed.");

const availableLanguages = getAvailableLanguages() as [string, ...string[]];

const updateUserProfileInput = z.object({
    userId: z.string().regex(/^tcm:0-\d+-65552$/).describe("The TCM URI of the user whose profile is to be updated (e.g., 'tcm:0-20-65552')."),
    favorites: z.array(favoriteLinkSchema).optional().describe("A complete array of favorite items to REPLACE the user's entire existing list."),
    addFavorites: z.array(favoriteLinkSchema).optional().describe("An array of favorite items to ADD to the user's existing list. Duplicates will be ignored."),
    removeFavorites: z.array(favoriteLinkSchema).optional().describe("An array of favorite items to REMOVE from the user's existing list."),
    languageName: z.enum(availableLanguages).optional().describe("The new language for the user."),
    localeId: z.number().int().optional().describe("The new locale ID for the user (e.g., 13321 for English/United States with AM/PM)."),
    description: z.string().optional().describe("The new description for the user."),
    userProfileJson: z.string().optional().describe("ADVANCED: A JSON string representing the entire UserProfile object. If provided, this will completely replace the user's profile. This option overrides all other specific parameters.")
}).refine(data =>
    data.favorites !== undefined ||
    data.addFavorites !== undefined ||
    data.removeFavorites !== undefined ||
    data.languageName !== undefined ||
    data.localeId !== undefined ||
    data.description !== undefined ||
    data.userProfileJson !== undefined, {
    message: "At least one update property must be provided."
}).refine(data =>
    !(data.userProfileJson && (data.favorites !== undefined || data.addFavorites !== undefined || data.removeFavorites !== undefined || data.languageName !== undefined || data.localeId !== undefined || data.description !== undefined)), {
    message: "When 'userProfileJson' is provided, other specific update parameters are not allowed."
}).refine(data =>
    !(data.favorites && (data.addFavorites !== undefined || data.removeFavorites !== undefined)), {
    message: "The 'favorites' parameter (for full replacement) cannot be used at the same time as 'addFavorites' or 'removeFavorites'."
});

type UpdateUserProfileInput = z.infer<typeof updateUserProfileInput>;

export const updateUserProfile = {
    name: "updateUserProfile",
    description: `Updates a user's profile by either modifying specific properties or replacing the entire profile with a JSON object.

There are three ways to manage favorites:
1.  **Add/Remove (Recommended)**: Use the 'addFavorites' and 'removeFavorites' parameters to easily modify the existing list.
2.  **Full Replacement**: Provide a complete list to the 'favorites' parameter. This will overwrite all existing favorites.
3.  **Advanced JSON**: Provide a complete UserProfile JSON string to the 'userProfileJson' parameter to replace the entire profile.

Example: Add a new favorite and remove an existing one for user 'tcm:0-20-65552'.
The tool will fetch the user's current favorites, remove the item with ID 'tcm:4-5-8', add the item with ID 'tcm:5-484-2', and then save the updated list.

    const result = await tools.updateUserProfile({
        userId: "tcm:0-20-65552",
        addFavorites: [
            { "IdRef": "tcm:5-484-2" }
        ],
        removeFavorites: [
            { "IdRef": "tcm:4-5-8" }
        ]
    });
`,
    input: updateUserProfileInput,
    execute: async (params: UpdateUserProfileInput, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { userId, favorites, addFavorites, removeFavorites, languageName, localeId, description, userProfileJson } = params;
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
                } else if (addFavorites !== undefined || removeFavorites !== undefined) {
                    if (!userProfilePayload.Preferences) userProfilePayload.Preferences = { "$type": "UserPreferences" };
                    let currentFavorites = userProfilePayload.Preferences.Favorites || [];
                    
                    if (removeFavorites) {
                        const removeIds = new Set(removeFavorites.map(fav => fav.IdRef));
                        currentFavorites = currentFavorites.filter((fav: any) => !removeIds.has(fav.IdRef));
                    }

                    if (addFavorites) {
                        const currentIds = new Set(currentFavorites.map((fav: any) => fav.IdRef));
                        const newFavoritesToAdd = addFavorites
                            .filter(fav => !currentIds.has(fav.IdRef))
                            .map(fav => ({ "$type": "FavoriteLink", "IdRef": fav.IdRef }));
                        currentFavorites.push(...newFavoritesToAdd);
                    }
                    userProfilePayload.Preferences.Favorites = currentFavorites;
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