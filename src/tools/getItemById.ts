import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getItemById = {
    name: "getItemById",
    description: `Retrieves read-only details for a single Content Manager System (CMS) item using its unique ID.
The returned details typically include the item type ($type), identified (Id), title (Title),
actions that can be performed on the item (ApplicableActions), the schema or metadata schema the
item uses for custom field values (Schema, MetadataSchema), content field values (Content),
metadata field values (Metadata), version information like creation and revision dates (VersionInfo) etc.
This tool cannot modify, update, or delete any CMS items or files.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item."),
    },
    execute: async ({ itemId }: { itemId: string }) => {
        try {
            const restItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${restItemId}`);

            if (response.status === 200) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(response.data, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to authenticate or retrieve item");
        }
    }
};