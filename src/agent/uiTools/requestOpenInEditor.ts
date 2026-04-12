import { z } from "zod";

export const requestOpenInEditor = {
    name: "requestOpenInEditor",
    summary: "Opens a specific CMS item in its dedicated editor view.",
    description: "Opens a specific item in its editor view. Only use this tool when the user explicitly asks to 'open' or 'edit' an item.",
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