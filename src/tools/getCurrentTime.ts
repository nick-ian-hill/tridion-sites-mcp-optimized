import { handleAxiosError } from "../utils/errorUtils.js";

export const getCurrentTime = {
    name: "getCurrentTime",
    description: "Returns the current date and time in ISO 8601 format. Use this to get the precise current time for time-sensitive calculations, especially in long-running conversations.",
    input: {},
    execute: async () => {
        try {
            const now = new Date().toISOString();
            const response = {
                $type: "CurrentTime",
                ISOTime: now
            };
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(response, null, 2)
                }],
            };
        } catch (error) {
            return handleAxiosError(error, "Error getting current time");
        }
    }
};