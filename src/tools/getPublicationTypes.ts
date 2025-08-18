import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getPublicationTypes = {
    name: "getPublicationTypes",
    description: "Retrieves a list of all available Publication Types (e.g., 'Web', 'Content', 'Mobile'). These types help categorize and manage Publications based on their intended purpose or channel.",
    input: {},
    execute: async () => {
        try {
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