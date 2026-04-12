import { z } from "zod";

export const requestNavigation = {
    name: "requestNavigation",
    summary: "Navigates the user's Content Manager view to a specific item or container.",
    description: "Navigates the user's view to a specific item. Only use this tool when the user explicitly asks to 'navigate to', 'select', 'browse into' an item, or words to that effect.",
    input: {
        itemId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).describe("The TCM URI of the item to navigate to."),
        navigateInto: z.boolean().optional().default(false).describe("Set to true to navigate INTO a container item (like a Folder or Structure Group) instead of selecting it."),
    },
    execute: async ({ itemId, navigateInto = false }: { itemId: string; navigateInto?: boolean }) => {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({
                    isUiAction: true,
                    action: { type: 'navigate', payload: { itemId, navigateInto } }
                })
            }],
        };
    }
};