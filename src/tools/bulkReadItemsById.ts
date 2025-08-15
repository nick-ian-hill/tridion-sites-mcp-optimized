import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const bulkReadItemsById = {
    name: "bulkReadItemsById",
    description: `Retrieves read-only details for an array of Content Manager System (CMS) items using their IDs.
This tool is more efficient than calling getItemById for each item individually.
The returned data is an 'IdentifiableObjectDictionary' type, which maps each item ID to its details.
The 'useDynamicVersion' parameter, when set to true, loads the latest saved data for versioned items.
The 'loadFullItems' parameter, when set to true, loads the full content and metadata for each item.

The following item types are versioned: Components, Component Templates, Pages, Page Templates, Schemas,
and Template Building Blocks.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

This tool cannot modify, update, or delete any CMS items or files.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).describe("An array of unique IDs for the items to retrieve."),
        useDynamicVersion: z.boolean().default(false).describe("When true, loads the latest revisions for versioned items. Defaults to false."),
        loadFullItems: z.boolean().default(false).describe("When true, loads the full content and metadata for each item. Defaults to false."),
    },
    execute: async ({ itemIds, useDynamicVersion, loadFullItems }: { itemIds: string[], useDynamicVersion: boolean, loadFullItems: boolean }) => {
        try {
            const response = await authenticatedAxios.get(`/items/bulkRead`, {
                params: {
                    itemIds: itemIds,
                    useDynamicVersion: useDynamicVersion,
                    loadFullItems: loadFullItems,
                }
            });

            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(response.data, null, 2)
                        }
                    ],
                };
            } else {
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status: ${response.status}` },
                    ],
                };
            }
        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to authenticate or retrieve items: ${errorMessage}` }],
            };
        }
    }
};