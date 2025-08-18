import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

export const updateComponentById = {
    name: "updateComponentById",
    description: `Updates content and/or metadata field values for a single Content Manager System (CMS) item of type 'Component' with the specified ID.The ID of the schema defining the allowed content and metadata fields can be found under the component's 'Schema' property.Fields are defined using XML Schema Definition 1.0.This tool cannot be used to update other item types or other component fields (e.g., Title).`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the component to update, without the version number."),
        content: z.string().optional().describe("The updated content for the component. Must be a string representing a valid JSON object."),
        metadata: z.string().optional().describe("The updated metadata for the component. Must be a string representing a valid JSON object."),
    },
    execute: async ({ itemId, content, metadata }: { itemId: string, content?: string, metadata?: string }) => {
        let checkedOutItem = null;
        let agentId = null; // Declare agentId here
        const restItemId = itemId.replace(':', '_');

        try {
            // Step 0: Get the current user's (agent's) ID
            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) {
                throw new Error("Could not retrieve agent's user ID from whoAmI endpoint.");
            }

            // Step 1: Get the item to check its lock status.
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            const item = getItemResponse.data;
            const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;

            // Handle lock status
            if (isCheckedOut && checkedOutUser !== agentId) {
                // Item is checked out by another user, so we should not proceed.
                return {
                    content: [],
                    errors: [{ message: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }],
                };
            } else if (!isCheckedOut) {
                // Item is not checked out, proceed with a new checkout.
                const checkOutRequestModel = {
                    "$type": "CheckOutRequest",
                    "SetPermanentLock": true
                };
                const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, checkOutRequestModel);
                checkedOutItem = checkOutResponse.data;
            } else {
                // Item is checked out by the agent, so we can use the existing item data.
                checkedOutItem = item;
            }

            // Steps 3 & 4: Apply the new content and metadata to the stored item model.
            if (content) {
                try {
                    checkedOutItem.Content = JSON.parse(content);
                } catch (e) {
                    let errorMessage = "An unknown error occurred.";
                    if (e instanceof Error) {
                        errorMessage = e.message;
                    }
                    throw new Error(`Invalid JSON format for content: ${errorMessage}`);
                }
            }
            if (metadata) {
                try {
                    checkedOutItem.Metadata = JSON.parse(metadata);
                } catch (e) {
                    let errorMessage = "An unknown error occurred.";
                    if (e instanceof Error) {
                        errorMessage = e.message;
                    }
                    throw new Error(`Invalid JSON format for metadata: ${errorMessage}`);
                }
            }

            // Step 5: Update the component with a PUT request.
            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, checkedOutItem);
            if (updateResponse.status !== 200) {
                throw new Error(`Update failed with status: ${updateResponse.status}`);
            }

            // Step 6: Check in the item.
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
                throw new Error(`Check-in failed with status: ${checkInResponse.status}`);
            }
        } catch (error) {
            // In case of any error, attempt to undo the checkout to release the lock.
            // This undo checkout logic is only needed if the item was checked out as part of this tool run.
            // If the item was already checked out to the agent, we don't undo it.
            if (checkedOutItem && checkedOutItem?.VersionInfo?.CheckOutUser?.IdRef === agentId) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                    console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }

            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `Status ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to update component: ${errorMessage}` }],
            };
        }
    }
};