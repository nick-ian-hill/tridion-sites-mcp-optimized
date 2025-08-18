import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const localizeItemById = {
    name: "localizeItemById",
    description: `Localizes a shared item in the BluePrint, creating a local copy. This allows the item to be modified in the current context without affecting its parent item.
    Note that if a field is set to 'non-localizable' in the schema, it will not be possible to change the value in the local copy.
    The values for non-localizable fields are inherited from the primary item, that is, the instance of the item that is highest (closest to the root) in the BluePrint.
    The tool returns a confirmation that the item has been successfully localized.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID (TCM URI) of the shared item to localize."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/localize`);

            // A successful localization returns a 201 status code.
            if (response.status === 201) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully localized item ${itemId}. A new local copy has been created.\n\n${JSON.stringify(response.data, null, 2)}`
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
                ? (error.response ? `Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to localize item ${itemId}: ${errorMessage}` }],
            };
        }
    }
};