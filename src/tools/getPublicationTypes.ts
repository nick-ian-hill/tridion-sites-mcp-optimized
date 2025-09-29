import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

export const getPublicationTypes = {
    name: "getPublicationTypes",
    description: "Retrieves a list of all available Publication Types (e.g., 'Web', 'Content'). These types help categorize and manage Publications based on their intended purpose or channel. Type name can be used in the 'publicationType' parameter of the 'createPublication' and 'updatePublication' tools.",
    input: {},
    execute: async (_: {}, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const response = await authenticatedAxios.get('/publicationTypes');

            if (response.status === 200) {
                const publicationTypes = response.data;
                const titles = publicationTypes.map((type: { Title: string }) => type.Title);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(titles, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to retrieve publication types");
        }
    }
};