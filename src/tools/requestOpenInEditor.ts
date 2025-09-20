import { z } from "zod";

export const requestOpenInEditor = {
    name: "requestOpenInEditor",
    description: "Requests that the user interface open a specific item in its editor view. You should first ask the user if they want to open the item. Only call this tool if they respond affirmatively.",
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to open."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    isUiAction: true,
                    action: { type: 'openInEditor', payload: { itemId } }
                })
            }],
        };
    }
};