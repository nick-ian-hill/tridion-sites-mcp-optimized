import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const localizeItemById = {
    name: "localizeItemById",
    description: `Localizes a shared item in the BluePrint, creating a local copy that can be edited independently of its parent item.

This tool is only applicable to items that are shared (i.e., where BluePrintInfo.IsShared is true).
It will return an error if the item is a primary item (BluePrintInfo.IsShared: false and BluePrintInfo.IsLocalized: false).
The tool returns a confirmation that the item has been successfully localized.

Shared items are essentially identical copies of a parent item, and will be updated whenever the parent item changes.
Localizing a shared item makes many properties and content/metadata field values independent of the parent item.
Unless a content/metadata field is set to non-localizable, changes to the field value in the parent will not modify the value in the localized item.
Similarly, the values of fields that are not marked as non-localizable can be freely changed in the localized item.
A common use case for localizing an item is to translate content inherited from a parent item into a different language.
`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID (TCM URI) of the shared item to localize."),
    },
    execute: async ({ itemId }: { itemId: string }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedItemId = itemId.replace(':', '_');
            const response = await authenticatedAxios.post(`/items/${escapedItemId}/localize`);

            if (response.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully localized item ${itemId}. A new local copy has been created.\n\n${JSON.stringify(response.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to localize item ${itemId}. Check that BluePrintInfo.IsShared is true.`);
        }
    }
};