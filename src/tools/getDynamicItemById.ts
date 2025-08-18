import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const getDynamicItemById = {
    name: "getDynamicItemById",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item using its unique ID.
This tool should be used for "versioned" items to get the most recent saved data, including any revisions
made since the last major version.

The following item types are versioned: Components, Component Templates, Pages, Page Templates, Schemas,
and Template Building Blocks.

ID formats for versioned items:
- Components: tcm:integer-integer, tcm:integer-integer-16, ecl:integer-integer, or ecl:integer-integer-16.
- Other versioned types (Schema, Page, Component Template, Page Template): tcm:integer-integer-type, where 'type' is the item type number (Schema = 8, Page = 64, Component Template = 32, Page Template = 128, Template Building Block = 2048).

For items that do not support versioning or for versioned items without recent changes, this tool
returns the same data as getItemById. It cannot modify, update, or delete any CMS items or files.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            const restItemId = itemId.replace(':', '_');

            // Make a GET request to test item endpoint
            const response = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: {
                    useDynamicVersion: true
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
                errors: [{ message: `Failed to authenticate or retrieve item: ${errorMessage}` }],
            };
        }
    }
};