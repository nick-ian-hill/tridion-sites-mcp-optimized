import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const updateItemById = {
    name: "updateItemById",
    description: `Updates an existing Content Manager System (CMS) item of a specified type.
This tool can update various properties like title, description, metadataSchemaId, and parentKeywords.
For versioned item types ('Component', 'Page', 'Schema'), check-out and check-in are handled automatically.
To update an item's content or metadata, use the updateContentById or updateMetadataById tool respectively.
If a versioned item is locked by another user, the operation will be aborted.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the CMS item to update."),
        itemType: z.enum([
            "Component", "Folder", "StructureGroup", "Keyword",
            "Category", "Page", "Schema", "Bundle", "SearchFolder"
        ]).describe("The type of the CMS item to update."),
        // Optional fields for update, similar to createItem
        title: z.string().optional().describe("The new title for the item."),
        metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the item's metadata."),
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
        let wasCheckedOutByTool = false;

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: {
                    useDynamicVersion: true
                }
            });
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            let itemToUpdate = getItemResponse.data;

            if (isVersioned) {
                // --- Versioned Item Handling ---
                // 1. Get agent's user ID
                const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
                if (whoAmIResponse.status !== 200) {
                    return handleUnexpectedResponse(whoAmIResponse);
                }
                const agentId = whoAmIResponse.data?.User?.Id;
                if (!agentId) {
                    throw new Error("Could not retrieve agent's user ID from whoAmI endpoint.");
                }

                // 2. Check lock status of the item
                const isCheckedOut = itemToUpdate?.LockInfo?.LockType?.includes('CheckedOut');
                const checkedOutUser = itemToUpdate?.VersionInfo?.CheckOutUser?.IdRef;

                if (isCheckedOut && checkedOutUser !== agentId) {
                    return {
                        content: [{
                            type: "text",
                            text: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.`
                        }],
                        errors: [],
                    };
                }

                // 3. Check out if necessary
                if (!isCheckedOut) {
                    const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, {
                        "$type": "CheckOutRequest",
                        "SetPermanentLock": true
                    });
                    if (checkOutResponse.status !== 200) {
                        return handleUnexpectedResponse(checkOutResponse);
                    }
                    itemToUpdate = checkOutResponse.data;
                    wasCheckedOutByTool = true;
                }
            }

            // --- Apply Updates to the Item JSON ---
            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.schemaId) itemToUpdate.Schema = toLink(updates.schemaId);
            if (updates.metadataSchemaId) itemToUpdate.MetadataSchema = toLink(updates.metadataSchemaId);
            if (updates.description) itemToUpdate.Description = updates.description;

            // Type-specific updates
            if (itemType === 'Page') {
                if (updates.fileName) itemToUpdate.FileName = updates.fileName;
                if (updates.pageTemplateId) itemToUpdate.PageTemplate = toLink(updates.pageTemplateId);
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
                return handleUnexpectedResponse(updateResponse);
            }
            const updatedItem = updateResponse.data;

            // --- Check-in for versioned items ---
            if (isVersioned && wasCheckedOutByTool) {
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, {
                    "$type": "CheckInRequest",
                    "RemovePermanentLock": true
                });
                if (checkInResponse.status !== 200) {
                    return handleUnexpectedResponse(checkInResponse);
                }
            }
            
            // --- Success for both versioned and non-versioned items ---
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

            return handleAxiosError(error, `Failed to update ${itemType} ${itemId}`);
        }
    }
};