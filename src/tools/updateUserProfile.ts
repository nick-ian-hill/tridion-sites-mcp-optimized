import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { getLanguageId } from "../utils/languageUtils.js";

const updateUserProfileInputProperties = {
    userId: z.string().regex(/^tcm:0-\d+-65552$/).optional().describe("The TCM URI of the user whose profile is to be updated (e.g., 'tcm:0-20-65552'). If not provided, it defaults to the currently logged-in user."),
    favorites: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("A complete array of favorite item URIs to REPLACE the user's entire existing list."),
    addFavorites: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of favorite item URIs to ADD to the user's existing list. Duplicates will be ignored."),
    removeFavorites: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of favorite item URIs to REMOVE from the user's existing list."),
    languageName: z.enum([
        'German',
        'English',
        'Spanish',
        'French',
        'Dutch',
        'Japanese',
        'Chinese'
    ]).optional().describe("The new language for the user."),
    localeId: z.number().int().optional().describe("The new locale ID for the user, using Microsoft Windows Locale ID (LCID) codes (e.g., 1033 for English/United States)."),
    description: z.string().optional().describe("The new description for the user."),
    userProfileJson: z.string().optional().describe("ADVANCED: A JSON string representing the entire UserProfile object. If provided, this will completely replace the user's profile. This option overrides all other specific parameters.")
};

const updateUserProfileInputSchema = z.object(updateUserProfileInputProperties).refine(data =>
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

type UpdateUserProfileInput = z.infer<typeof updateUserProfileInputSchema>;

export const updateUserProfile = {
    name: "updateUserProfile",
    description: `Updates a user's profile by modifying specific properties or replacing the entire profile. If 'userId' is not specified, the profile of the currently logged-in user will be updated.

There are three ways to manage favorites:
1.  **Add/Remove (Recommended)**: Use 'addFavorites' and 'removeFavorites' to modify the existing list.
2.  **Full Replacement**: Provide a complete list to the 'favorites' parameter to overwrite all existing favorites.
3.  **Advanced JSON**: Provide a complete UserProfile JSON string to 'userProfileJson' to replace the entire profile.

Example 1: Add a new favorite and remove an existing one for user 'tcm:0-20-65552'.
    const result = await tools.updateUserProfile({
        userId: "tcm:0-20-65552",
        addFavorites: [ "tcm:5-484-2" ],
        removeFavorites: [ "tcm:4-5-8" ]
    });

Example 2: Update the current user's language to German.
    const result = await tools.updateUserProfile({
        languageName: "German"
    });
`,
    input: updateUserProfileInputProperties,
    execute: async (params: UpdateUserProfileInput, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { favorites, addFavorites, removeFavorites, languageName, localeId, description, userProfileJson } = params;
        let userId: string | undefined = params.userId;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            if (!userId) {
                const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
                if (whoAmIResponse.status === 200 && whoAmIResponse.data?.User?.Id) {
                    userId = whoAmIResponse.data.User.Id;
                } else if (whoAmIResponse.status !== 200) {
                    return handleUnexpectedResponse(whoAmIResponse);
                } else {
                    return { content: [{ type: "text", text: "Error: Could not determine the current user's ID from the whoAmI response." }], errors: [] };
                }
            }
            
            if (!userId) {
                return { content: [{ type: "text", text: "Error: User ID could not be determined." }], errors: [] };
            }

            const restUserId = userId.replace(':', '_');
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
                    const newFavorites = favorites.map(favId => ({ "$type": "FavoriteLink", "IdRef": favId }));
                    if (!userProfilePayload.Preferences) userProfilePayload.Preferences = { "$type": "UserPreferences" };
                    userProfilePayload.Preferences.Favorites = newFavorites;
                } else if (addFavorites !== undefined || removeFavorites !== undefined) {
                    if (!userProfilePayload.Preferences) userProfilePayload.Preferences = { "$type": "UserPreferences" };
                    let currentFavorites = userProfilePayload.Preferences.Favorites || [];
                    
                    if (removeFavorites) {
                        const removeIds = new Set(removeFavorites);
                        currentFavorites = currentFavorites.filter((fav: any) => !removeIds.has(fav.IdRef));
                    }

                    if (addFavorites) {
                        const currentIds = new Set(currentFavorites.map((fav: any) => fav.IdRef));
                        const newFavoritesToAdd = addFavorites
                            .filter(favId => !currentIds.has(favId))
                            .map(favId => ({ "$type": "FavoriteLink", "IdRef": favId }));
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
                        text: `Successfully updated profile for user ${userId}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(updateResponse);
            }

        } catch (error) {
            const userIdentifier = userId || "the current user";
            return handleAxiosError(error, `Failed to update profile for ${userIdentifier}`);
        }
    }
};