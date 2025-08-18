import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLinkArray } from "../utils/links.js";

export const updateItemById = {
    name: "updateItemById",
    description: `Updates an existing Content Manager System (CMS) item of a specified type.
This tool can update various properties like title, description, content, and metadata.
For versioned item types ('Component', 'Page', 'Schema'), it automatically handles check-out and check-in.
If only updating content or metadata for a Component, you can use the updateComponentById tool.
If the item is locked by another user, the operation will be aborted.`,
    input: {
        itemId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The unique ID of the CMS item to update."),
        itemType: z.enum([
            "Component", "Folder", "StructureGroup", "Keyword",
            "Category", "Page", "Schema", "Bundle", "SearchFolder"
        ]).describe("The type of the CMS item to update."),
        // Optional fields for update, similar to createItem
        title: z.string().optional().describe("The new title for the item."),
        schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Schema to use for the item's content. (Applicable to Component/Page)"),
        metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the item's metadata."),
        content: z.record(z.any()).optional().describe("A JSON object for the item's content fields. Replaces existing content."),
        metadata: z.record(z.any()).optional().describe("A JSON object for the item's metadata fields. Replaces existing metadata."),
        fileName: z.string().optional().describe("The new file name for the page. (Applicable to Page)"),
        pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the Page Template. (Applicable to Page)"),
        isAbstract: z.boolean().optional().describe("Set to true to make a Keyword abstract. (Applicable to Keyword)"),
        description: z.string().optional().describe("A new description for the item."),
        key: z.string().optional().describe("A new custom key for the Keyword. (Applicable to Keyword)"),
        parentKeywords: z.array(z.string().regex(/^tcm:\d+-\d+-1024$/)).optional().describe("An array of parent Keyword URIs. Replaces existing parents. (Applicable to Keyword)"),
        relatedKeywords: z.array(z.string().regex(/^tcm:\d+-\d+-1024$/)).optional().describe("An array of related Keyword URIs. Replaces existing relations. (Applicable to Keyword)"),
        itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of item URIs for the Bundle. Replaces existing items. (Applicable to Bundle)"),
        searchQuery: SearchQueryValidation.optional().describe("A new search query model for the Search Folder."),
        resultLimit: z.number().int().optional().describe("A new result limit for the Search Folder.")
    },
    execute: async (params: any) => {
        const { itemId, itemType, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
        const versionedItemTypes = ["Component", "Page", "Schema"];
        const isVersioned = versionedItemTypes.includes(itemType);

        let agentId = null;
        let wasCheckedOutByTool = false;

        try {
            let itemToUpdate;

            if (isVersioned) {
                // --- Versioned Item Handling ---
                // 1. Get agent's user ID
                const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
                agentId = whoAmIResponse.data?.User?.Id;
                if (!agentId) {
                    throw new Error("Could not retrieve agent's user ID from whoAmI endpoint.");
                }

                // 2. Get item and check lock status
                const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
                const currentItem = getItemResponse.data;
                const isCheckedOut = currentItem?.LockInfo?.LockType?.includes('CheckedOut');
                const checkedOutUser = currentItem?.VersionInfo?.CheckOutUser?.IdRef;

                if (isCheckedOut && checkedOutUser !== agentId) {
                    return {
                        content: [],
                        errors: [{ message: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }],
                    };
                }

                // 3. Check out if necessary, or get dynamic version if already checked out by agent
                if (!isCheckedOut) {
                    const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, {
                        "$type": "CheckOutRequest",
                        "SetPermanentLock": true
                    });
                    itemToUpdate = checkOutResponse.data;
                    wasCheckedOutByTool = true;
                } else {
                    // Already checked out by agent, get the latest dynamic version to apply updates to
                    const dynamicItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                        params: { useDynamicVersion: true }
                    });
                    itemToUpdate = dynamicItemResponse.data;
                }
            } else {
                // --- Non-Versioned Item Handling ---
                const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
                itemToUpdate = getItemResponse.data;
            }

            // --- Apply Updates to the Item JSON ---
            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.schemaId) itemToUpdate.Schema = { IdRef: updates.schemaId };
            if (updates.metadataSchemaId) itemToUpdate.MetadataSchema = { IdRef: updates.metadataSchemaId };
            if (updates.content) itemToUpdate.Content = updates.content;
            if (updates.metadata) itemToUpdate.Metadata = updates.metadata;
            if (updates.description) itemToUpdate.Description = updates.description;

            // Type-specific updates
            if (itemType === 'Page') {
                if (updates.fileName) itemToUpdate.FileName = updates.fileName;
                if (updates.pageTemplateId) itemToUpdate.PageTemplate = { IdRef: updates.pageTemplateId };
            }
            if (itemType === 'Keyword') {
                if (updates.isAbstract !== undefined) itemToUpdate.IsAbstract = updates.isAbstract;
                if (updates.key) itemToUpdate.Key = updates.key;
                if (updates.parentKeywords) itemToUpdate.ParentKeywords = toLinkArray(updates.parentKeywords);
                if (updates.relatedKeywords) itemToUpdate.RelatedKeywords = toLinkArray(updates.relatedKeywords);
            }
            if (itemType === 'Bundle' && updates.itemsInBundle) {
                itemToUpdate.Items = toLinkArray(updates.itemsInBundle);
            }
            if (itemType === 'SearchFolder' && updates.searchQuery) {
                itemToUpdate.Configuration = generateSearchFolderXmlConfiguration(updates.searchQuery, updates.resultLimit);
            }

            // --- Send PUT request to update the item ---
            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                throw new Error(`Update failed with status: ${updateResponse.status} - ${updateResponse.statusText}`);
            }
            const updatedItem = updateResponse.data;

            // --- Check-in for versioned items ---
            if (isVersioned) {
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, {
                    "$type": "CheckInRequest",
                    "RemovePermanentLock": true
                });
                if (checkInResponse.status !== 200) {
                    throw new Error(`Check-in failed with status: ${checkInResponse.status}`);
                }
                return {
                    content: [{ type: "text", text: `Successfully updated and checked in ${itemType} ${itemId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
                };
            }

            // --- Success for non-versioned items ---
            return {
                content: [{ type: "text", text: `Successfully updated ${itemType} ${itemId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
            };

        } catch (error) {
            // --- Error Handling & Undo Checkout ---
            if (isVersioned && wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                    console.error(`Successfully undid checkout for item ${itemId} due to an error.`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }

            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to update ${itemType} ${itemId}: ${errorMessage}` }],
            };
        }
    }
};