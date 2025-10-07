import { z } from "zod";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

export const mapItemIdToContextPublication = {
    name: "localizeItemId",
    description: "Transforms an item ID (TCM URI) from one Publication context to another. Use this as the first step to recover from a BluePrint error like 'Cannot paste across Publications'. For example, if you have an item 'tcm:4-291' and your target context is in Publication 5 (e.g., folder 'tcm:5-123'), this tool will return 'tcm:5-291'. You can then use 'getItem' with this new ID to check if the localized item exists.",
    input: {
        itemId: z.string().describe("The item ID to be transformed."),
        contextItemId: z.string().describe("An item ID that is in the target Publication context."),
    },
    execute: async ({ itemId, contextItemId }: { itemId: string, contextItemId: string }) => {
        const localizedId = convertItemIdToContextPublication(itemId, contextItemId);
        return {
            localizedId: localizedId
        };
    }
};