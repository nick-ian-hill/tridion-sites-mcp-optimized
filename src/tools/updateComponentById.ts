import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

export const updateComponentById = {
    name: "updateComponentById",
    description: `Updates content and/or metadata field values for a single Content Manager System (CMS) item of type 'Component' with the specified ID. The ID of the schema defining the allowed content and metadata fields can be found under the component's 'Schema' property. Fields are defined using XML Schema Definition 1.0. This tool cannot be used to update other item types or other component fields (e.g., Title).`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the component to update. The item type (the third number in the ID) must be 16, but is optional."),
        content: z.record(fieldValueSchema).optional().describe("A JSON object for the component's content fields. Replaces existing content."),
        metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the component's metadata fields. Replaces existing metadata."),
    },
    execute: async ({ itemId, content, metadata }: { itemId: string, content?: Record<string, any>, metadata?: Record<string, any> }) => {
        let wasCheckedOutByTool = false;
        const restItemId = itemId.replace(':', '_');

        try {
            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            if (whoAmIResponse.status !== 200) {
                return handleUnexpectedResponse(whoAmIResponse);
            }
            const agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) {
                return handleAxiosError(new Error("Could not retrieve agent's user ID from whoAmI endpoint."), "Failed to update component");
            }

            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            const item = getItemResponse.data;
            const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;
            let itemToUpdate;

            if (isCheckedOut && checkedOutUser !== agentId) {
                return {
                    content: [{
                        type: "text",
                        text: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.`
                    }],
                    errors: [],
                };
            } else if (!isCheckedOut) {
                const checkOutRequestModel = {
                    "$type": "CheckOutRequest",
                    "SetPermanentLock": true
                };
                const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, checkOutRequestModel);
                 if (checkOutResponse.status !== 200) {
                    return handleUnexpectedResponse(checkOutResponse);
                }
                itemToUpdate = checkOutResponse.data;
                wasCheckedOutByTool = true;
            } else {
                const dynamicItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                    params: { useDynamicVersion: true }
                });
                 if (dynamicItemResponse.status !== 200) {
                    return handleUnexpectedResponse(dynamicItemResponse);
                }
                itemToUpdate = dynamicItemResponse.data;
            }

            if (content) {
                itemToUpdate.Content = content;
            }
            if (metadata) {
                itemToUpdate.Metadata = metadata;
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }

            const checkInRequestModel = {
                "$type": "CheckInRequest",
                "RemovePermanentLock": true
            };
            const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, checkInRequestModel);
            if (checkInResponse.status === 200) {
                return {
                    content: [{ type: "text", text: `Successfully updated and checked in component ${itemId}.` }],
                };
            } else {
                return handleUnexpectedResponse(checkInResponse);
            }
        } catch (error) {
            if (wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                    console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }

            return handleAxiosError(error, "Failed to update component");
        }
    }
};