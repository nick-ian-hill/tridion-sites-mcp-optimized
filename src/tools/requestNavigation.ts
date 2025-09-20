import { z } from "zod";

export const requestNavigation = {
    name: "requestNavigation",
    description: "Requests that the user interface navigate to a specific item's location. This should be the primary action to perform immediately after successfully creating any new item.",
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to navigate to."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    isUiAction: true,
                    action: { type: 'navigate', payload: { itemId } }
                })
            }],
        };
    }
};