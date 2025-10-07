import { z } from "zod";

/**
 * Helper function to find and extract the array of items from various
 * possible response structures returned by other tools.
 * This logic is inspired by the patterns in responseFiltering.ts.
 * @param data The raw data from a previous tool's output.
 * @returns An array of items, or an empty array if none are found.
 */
const extractItemsArray = (data: any): any[] => {
    if (!data) {
        return [];
    }

    let actualData = data;

    if (data.content && Array.isArray(data.content) && data.content[0]?.type === 'text' && typeof data.content[0].text === 'string') {
        try {
            actualData = JSON.parse(data.content[0].text);
        } catch (e) {
            console.error("Failed to parse JSON from tool output text:", e);
            return []; // Cannot parse, so there are no items to count.
        }
    }

    // Case 1: The data itself is the array of items.
    if (Array.isArray(actualData)) {
        return actualData;
    }

    // Case 2: The data is an object with an 'items' property (e.g., from getItemsInContainer).
    if (actualData.items && Array.isArray(actualData.items)) {
        return actualData.items;
    }

    // Case 3: The data is an object with an 'Items' property (used by some API endpoints).
    if (actualData.Items && Array.isArray(actualData.Items)) {
        return actualData.Items;
    }

    // Case 4: The data is a single object, not in an array (e.g., from getItem).
    if (typeof actualData === 'object' && Object.keys(actualData).length > 0) {
        return [actualData];
    }

    // Default case: No countable items found.
    return [];
};

export const countItems = {
    name: "countItems",
    description: "Counts the number of items in a provided data structure from a previous tool call. It intelligently handles different response formats from tools like 'search' or 'getItemsInContainer'. Use this tool when asked to return an item count on the results of a tool call.",
    input: {
        data: z.any().describe("The data returned from a previous tool call, which contains the items to be counted."),
    },
    execute: async ({ data }: { data: any }) => {
        const items = extractItemsArray(data);
        const count = items.length;
        
        return {
            count: count,
            summary: `There are ${count} items in the list.`
        };
    }
};