import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const getPublicationTypes = {
    name: "getPublicationTypes",
    description: "Retrieves a list of all available Publication Types (e.g., 'Web', 'Content', 'Mobile'). These types help categorize and manage Publications based on their intended purpose or channel.",
    input: {},
    execute: async () => {
        try {
            // Make the GET request to the publicationTypes endpoint.
            const response = await authenticatedAxios.get('/publicationTypes');

            // A successful request will return a 200 OK status.
            if (response.status === 200) {
                // Extract the array of objects from the response
                const publicationTypes = response.data;

                // Process the array to get only the 'Title' property from each object
                const titles = publicationTypes.map((type: { Title: string }) => type.Title);

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(titles, null, 2)
                        }
                    ],
                };
            } else {
                // Handle any unexpected, non-error status codes.
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status: ${response.status}` },
                    ],
                };
            }
        } catch (error) {
            // Handle errors from the API call, such as a 500 Internal Server Error.
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to retrieve publication types: ${errorMessage}` }],
            };
        }
    }
};