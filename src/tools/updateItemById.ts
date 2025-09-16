import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

const updateItemByIdInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the CMS item to update."),
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Schema", "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate"
    ]).describe("The type of the CMS item to update."),
    title: z.string().optional().describe("The new title for the item."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the item's metadata."),
    isAbstract: z.boolean().optional().describe("Set to true to make a Keyword abstract. (Applicable to Keyword)"),
    description: z.string().optional().describe("A new description for the item."),
    key: z.string().optional().describe("A new custom key for the Keyword. (Applicable to Keyword)"),
    parentKeywords: z.array(z.string().regex(/^tcm:\d+-\d+-1024$/)).optional().describe("An array of parent Keyword URIs. Replaces existing parents. (Applicable to Keyword)"),
    relatedKeywords: z.array(z.string().regex(/^tcm:\d+-\d+-1024$/)).optional().describe("An array of related Keyword URIs. Replaces existing relations. (Applicable to Keyword)"),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of item URIs for the Bundle. Replaces existing items. (Applicable to Bundle)"),
    searchQuery: SearchQueryValidation.optional().describe("A new search query model for the Search Folder."),
    resultLimit: z.number().int().optional().describe("A new result limit for the Search Folder."),
    fields: z.record(fieldDefinitionSchema).optional().describe("For Schema updates only. A dictionary of field definitions for the Schema's content. Replaces the existing fields."),
    metadataFields: z.record(fieldDefinitionSchema).optional().describe("For Schema updates only. A dictionary of field definitions for the Schema's metadata. Replaces the existing metadata fields."),
    fileExtension: z.string().optional().describe("A new file extension for the Page Template. (Applicable to PageTemplate)"),
    pageSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("A new Page Schema URI for the Page Template. (Applicable to PageTemplate)"),
    templateBuildingBlocks: z.array(z.string().regex(/^tcm:\d+-\d+-2048$/)).optional().describe("A new array of Template Building Block URIs. Replaces existing TBBs. (Applicable to PageTemplate/ComponentTemplate)"),
    allowOnPage: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the Component Template may be used on a Page."),
    isRepositoryPublishable: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the template renders dynamic Component Presentations."),
    outputFormat: z.string().optional().describe("For 'ComponentTemplate' type. The format of the rendered Component Presentation (e.g., 'HTML Fragment')."),
    priority: z.number().int().optional().describe("For 'ComponentTemplate' type. Priority used for resolving Component links."),
    relatedSchemaIds: z.array(z.string().regex(/^tcm:\d+-\d+-8$/)).optional().describe("For 'ComponentTemplate' type. An array of Schema TCM URIs to link to this template. Replaces any existing links.")
};

const updateItemByIdInputSchema = z.object(updateItemByIdInputProperties);

type UpdateItemByIdInput = z.infer<typeof updateItemByIdInputSchema>;

export const updateItemById = {
    name: "updateItemById",
    description: `Updates an existing Content Manager System (CMS) item.
This tool can update various properties like title, description, and metadataSchemaId.
For versioned items ('Component', 'Schema', 'PageTemplate', 'ComponentTemplate'), check-out and check-in are handled automatically.
In particular, if an item is not checked out, it will be checked back in after updating.
If the item is already checked out to the current user, it will remain checked out to that user after the update. If a versioned item is locked by another user, the operation will be aborted.
This tool can also update the field definitions of a Schema by providing the 'fields' or 'metadataFields' properties.
To update an item's content or metadata values, use the 'updateContentById' or 'updateMetadataById' tools respectively.`,
    input: updateItemByIdInputProperties,
    execute: async (params: UpdateItemByIdInput, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, itemType, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
        const versionedItemTypes = ["Component", "Schema", "PageTemplate", "ComponentTemplate"];
        const isVersioned = versionedItemTypes.includes(itemType);
        let wasCheckedOutByTool = false;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            if (updates.metadataSchemaId) {
                updates.metadataSchemaId = convertItemIdToContextPublication(updates.metadataSchemaId, itemId);
            }
            if (updates.parentKeywords) {
                updates.parentKeywords = updates.parentKeywords.map((kw: string) => convertItemIdToContextPublication(kw, itemId));
            }
            if (updates.relatedKeywords) {
                updates.relatedKeywords = updates.relatedKeywords.map((kw: string) => convertItemIdToContextPublication(kw, itemId));
            }
            if (updates.itemsInBundle) {
                updates.itemsInBundle = updates.itemsInBundle.map((item: string) => convertItemIdToContextPublication(item, itemId));
            }
            if (updates.pageSchemaId) {
                updates.pageSchemaId = convertItemIdToContextPublication(updates.pageSchemaId, itemId);
            }
            if (updates.templateBuildingBlocks) {
                updates.templateBuildingBlocks = updates.templateBuildingBlocks.map((tbbId: string) => convertItemIdToContextPublication(tbbId, itemId));
            }
            if (updates.relatedSchemaIds) {
                updates.relatedSchemaIds = updates.relatedSchemaIds.map((id: string) => convertItemIdToContextPublication(id, itemId));
            }
            if (updates.searchQuery) {
                const contextId = updates.searchQuery.SearchIn || itemId;

                if (updates.searchQuery.SearchIn) {
                    updates.searchQuery.SearchIn = convertItemIdToContextPublication(updates.searchQuery.SearchIn, itemId);
                }
                if (updates.searchQuery.BasedOnSchemas) {
                    updates.searchQuery.BasedOnSchemas = updates.searchQuery.BasedOnSchemas.map(schemaFilter => ({
                        ...schemaFilter,
                        schemaUri: convertItemIdToContextPublication(schemaFilter.schemaUri, contextId)
                    }));
                }
                if (updates.searchQuery.UsedKeywords) {
                    updates.searchQuery.UsedKeywords = updates.searchQuery.UsedKeywords.map((keywordUri: string) =>
                        convertItemIdToContextPublication(keywordUri, contextId)
                    );
                }
                if (updates.searchQuery.ActivityDefinition) {
                    updates.searchQuery.ActivityDefinition = convertItemIdToContextPublication(updates.searchQuery.ActivityDefinition, contextId);
                }
                if (updates.searchQuery.ProcessDefinition) {
                    updates.searchQuery.ProcessDefinition = convertItemIdToContextPublication(updates.searchQuery.ProcessDefinition, contextId);
                }
            }

            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: { useDynamicVersion: true }
            });
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            let itemToUpdate = getItemResponse.data;

            if (isVersioned) {
                const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
                if (whoAmIResponse.status !== 200) return handleUnexpectedResponse(whoAmIResponse);
                const agentId = whoAmIResponse.data?.User?.Id;
                if (!agentId) throw new Error("Could not retrieve agent's user ID.");

                const isCheckedOut = itemToUpdate?.LockInfo?.LockType?.includes('CheckedOut');
                const checkedOutUser = itemToUpdate?.VersionInfo?.CheckOutUser?.IdRef;

                if (isCheckedOut && checkedOutUser !== agentId) {
                    return { content: [{ type: "text", text: `Item ${itemId} is already checked out by another user with ID ${checkedOutUser}.` }], errors: [] };
                }

                if (!isCheckedOut) {
                    const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, { "$type": "CheckOutRequest", "SetPermanentLock": true });
                    if (checkOutResponse.status !== 200) return handleUnexpectedResponse(checkOutResponse);
                    itemToUpdate = checkOutResponse.data;
                    wasCheckedOutByTool = true;
                }
            }

            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.metadataSchemaId) itemToUpdate.MetadataSchema = toLink(updates.metadataSchemaId);
            if (updates.description) itemToUpdate.Description = updates.description;

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
            if (itemType === 'Schema') {
                const schemaLocationId = itemToUpdate.LocationInfo?.OrganizationalItem?.IdRef;
                if (!schemaLocationId) {
                    throw new Error(`Could not determine location for Schema ${itemId} to process field definitions.`);
                }
                if (updates.fields) {
                    const processedFields = await processSchemaFieldDefinitions(updates.fields, schemaLocationId, authenticatedAxios);
                    itemToUpdate.Fields = { "$type": "FieldsDefinitionDictionary", ...processedFields };
                }
                if (updates.metadataFields) {
                    const processedMetadataFields = await processSchemaFieldDefinitions(updates.metadataFields, schemaLocationId, authenticatedAxios);
                    itemToUpdate.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
                }
            }
            if (itemType === 'PageTemplate' || itemType === 'ComponentTemplate') {
                if (updates.templateBuildingBlocks) {
                    const tbbInvocations = updates.templateBuildingBlocks.map((tbbId: string) =>
                        `<TemplateInvocation><Template xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${tbbId}" xlink:title="" /></TemplateInvocation>`
                    ).join('');
                    itemToUpdate.Content = `<CompoundTemplate xmlns="http://www.tridion.com/ContentManager/5.3/CompoundTemplate">${tbbInvocations}</CompoundTemplate>`;
                }
            }
            if (itemType === 'PageTemplate') {
                if (updates.fileExtension) itemToUpdate.FileExtension = updates.fileExtension;
                if (updates.pageSchemaId) {
                    itemToUpdate.PageSchema = toLink(updates.pageSchemaId);
                }
            }
            if (itemType === 'ComponentTemplate') {
                if (updates.allowOnPage !== undefined) itemToUpdate.AllowOnPage = updates.allowOnPage;
                if (updates.isRepositoryPublishable !== undefined) itemToUpdate.IsRepositoryPublishable = updates.isRepositoryPublishable;
                if (updates.outputFormat) itemToUpdate.OutputFormat = updates.outputFormat;
                if (updates.priority !== undefined) itemToUpdate.Priority = updates.priority;
                if (updates.relatedSchemaIds) itemToUpdate.RelatedSchemas = toLinkArray(updates.relatedSchemaIds);
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }
            const updatedItem = updateResponse.data;

            if (isVersioned && wasCheckedOutByTool) {
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
                if (checkInResponse.status !== 200) {
                    return handleUnexpectedResponse(checkInResponse);
                }
            }

            return {
                content: [{ type: "text", text: `Successfully updated ${itemType} ${itemId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
            };

        } catch (error) {
            if (isVersioned && wasCheckedOutByTool) {
                try {
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                } catch (undoError) {
                    console.error(`Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }
            return handleAxiosError(error, `Failed to update ${itemType} ${itemId}`);
        }
    }
};