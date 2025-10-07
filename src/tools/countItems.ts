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

    // Case 1: The data itself is the array of items.
    if (Array.isArray(data)) {
        return data;
    }

    // Case 2: The data is an object with an 'items' property (e.g., from getItemsInContainer).
    if (data.items && Array.isArray(data.items)) {
        return data.items;
    }

    // Case 3: The data is an object with an 'Items' property (used by some API endpoints).
    if (data.Items && Array.isArray(data.Items)) {
        return data.Items;
    }

    // Case 4: The data is a single object, not in an array (e.g., from getItem).
    if (typeof data === 'object' && Object.keys(data).length > 0) {
        return [data];
    }

    // Default case: No countable items found.
    return [];
};

export const countItems = {
    name: "countItems",
    description: "Counts the number of items in various data structures returned by other tools (like 'search' or 'getItemsInContainer'). Use this tool to get a precise total whenever the user asks 'how many' items were found or for the 'total number' of results from a tool call.",
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