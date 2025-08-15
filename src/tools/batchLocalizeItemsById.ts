import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const batchLocalizeItemsById = {
    name: "batchLocalizeItemsById",
    description: `Starts an asynchronous process to localize a batch of shared items in the BluePrint, creating local copies of each. This allows the items to be modified in the current context without affecting their parent items.
    Note that if a field is set to 'non-localizable' in a schema, it will not be possible to change the value in the local copy of an item based on that schema.
    This batch tool is more efficient than localizing items one by one and returns a confirmation that the process has been accepted and is running in the background.
    You can load the batch process referenced in the response to check the status of the process.`,
    input: {
        itemIds: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).describe("An array of unique IDs (TCM URIs) for the shared items to be localized."),
    },
    execute: async ({ itemIds }: { itemIds: string[] }) => {
        try {
            const requestModel = {
                Ids: itemIds
            };
            const response = await authenticatedAxios.post('/batch/localize', requestModel);

            // A successful batch request returns a 202 status code.
            if (response.status === 202) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Batch localization process started for ${itemIds.length} items.\n\n${JSON.stringify(response.data, null, 2)}`
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
                errors: [{ message: `Failed to start batch localization: ${errorMessage}` }],
            };
        }
    }
};