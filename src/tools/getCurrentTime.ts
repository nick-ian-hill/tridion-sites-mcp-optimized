export const getCurrentTime = {
    name: "getCurrentTime",
    description: "Returns the current date and time in ISO 8601 format. Use this to get the precise current time for time-sensitive calculations, especially in long-running conversations.",
    input: {},
    execute: async () => {
        try {
            const now = new Date().toISOString();
            return {
                content: [{
                    type: "text",
                    text: `The current time is ${now}.`
                }],
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error getting current time: ${errorMessage}` }],
            };
        }
    }
};