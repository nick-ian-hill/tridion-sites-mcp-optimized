import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema, fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { convertLinksRecursively, processSchemaFieldDefinitions, reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

const updateItemPropertiesInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the CMS item to update."),
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Schema", "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate"
    ]).describe("The type of the CMS item to update."),
    title: z.string().optional().describe("The new title for the item."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the item's metadata. Replaces the existing schema."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. May be required in the case of mandatory fields when changing the metadata schema. Replaces existing metadata."),
    isAbstract: z.boolean().optional().describe("Set to true to make a Keyword abstract. (Applicable to Keyword)"),
    description: z.string().optional().describe("A new description for the item."),
    key: z.string().optional().describe("A new custom key for the Keyword. (Applicable to Keyword)"),
    parentKeywords: z.array(z.string().regex(/^tcm:\d+-\d+-1024$/)).optional().describe("An array of parent Keyword URIs. Replaces existing parents. (Applicable to Keyword)"),
    relatedKeywords: z.array(z.string().regex(/^tcm:\d+-\d+-1024$/)).optional().describe("An array of related Keyword URIs. Replaces existing relations. (Applicable to Keyword)"),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of item URIs for the Bundle. Replaces existing items. (Applicable to Bundle)"),
    searchQuery: SearchQueryValidation.optional().describe("A new search query model for the Search Folder."),
    resultLimit: z.number().int().optional().describe("A new result limit for the Search Folder."),
    fields: z.record(fieldDefinitionSchema).optional().describe(`For Schema updates only. Replaces the entire collection of content fields.
    Use this for structural changes like adding, removing, or reordering fields.
    For modifying properties of existing fields (e.g., making a field optional), the 'updateSchemaFieldProperties' tool is strongly recommended as it is safer and more efficient.`),
    metadataFields: z.record(fieldDefinitionSchema).optional().describe(`For Schema updates only. Replaces the entire collection of metadata fields. The ONLY way to create a component with metadata fields is to use a component schema for which this property is defined.
    Use this for structural changes like adding, removing, or reordering fields.
    For modifying properties of existing fields (e.g., changing a description), the 'updateSchemaFieldProperties' tool is strongly recommended as it is safer and more efficient.`),
    fileExtension: z.string().optional().describe("A new file extension for the Page Template. (Applicable to PageTemplate)"),
    pageSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("A new Page Schema URI for the Page Template. (Applicable to PageTemplate)"),
    templateBuildingBlocks: z.array(z.string().regex(/^tcm:\d+-\d+-2048$/)).optional().describe("A new array of Template Building Block URIs. Replaces existing TBBs. (Applicable to PageTemplate/ComponentTemplate)"),
    allowOnPage: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the Component Template may be used on a Page."),
    isRepositoryPublishable: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the template renders dynamic Component Presentations."),
    outputFormat: z.string().optional().describe("For 'ComponentTemplate' type. The format of the rendered Component Presentation (e.g., 'HTML Fragment')."),
    priority: z.number().int().optional().describe("For 'ComponentTemplate' type. Priority used for resolving Component links."),
    relatedSchemaIds: z.array(z.string().regex(/^tcm:\d+-\d+-8$/)).optional().describe("For 'ComponentTemplate' type. An array of Schema TCM URIs to link to this template. Replaces any existing links."),
};

const updateItemPropertiesSchema = z.object(updateItemPropertiesInputProperties)
    .refine(
        (data) => !(data.itemType === 'Component' && data.metadataSchemaId),
        {
            message: `Validation Error: The 'metadataSchemaId' parameter cannot be used when 'itemType' is 'Component'.
                     A Component's metadata fields are defined directly on the Component Schema (using 'createComponentSchema').
                     To update metadata values, use the 'updateMetadata' tool.`
        }
    );

type UpdateItemPropertiesInput = z.infer<typeof updateItemPropertiesSchema>;

export const updateItemProperties = {
    name: "updateItemProperties",
    description: `Updates the core properties and structural definition of an existing Content Management System (CMS) item.

This tool modifies the definition of an item itself (e.g., its title, its Schema fields, its linked templates). 
To update only the content of a Component, use the 'updateContent' tool.
To update only the metadata values of any item, use the 'updateMetadata' tool.
To update a Workflow Process Definition, use the dedicated 'updateProcessDefinition' tool.

Example use cases by item type:
- All types: update 'title', 'description', and 'metadataSchemaId'. The 'metadata' can also be provided at the same time.
- Schema: update the content and metadata field definitions using the 'fields' and 'metadataFields' properties.
- Keyword: update 'isAbstract', 'key', 'parentKeywords', and 'relatedKeywords'.
- Bundle: update the list of 'itemsInBundle'.
- PageTemplate/ComponentTemplate: update the associated 'templateBuildingBlocks' and other template-specific properties.

When updating collection properties like 'fields', 'metadataFields', 'itemsInBundle', or 'relatedSchemaIds', the entire existing collection is replaced by the new value provided.

BluePrint Context & 404 Errors:
The ID parameters you provide (e.g., 'metadataSchemaId', 'parentKeywords', 'templateBuildingBlocks') MUST exist in the 'itemId's Publication or one of its parent Publications.

If you get a 404 'Not Found' error on an item you expect to inherit (like a Schema or TBB):
1.  It likely means the item is in a sibling or child Publication, not a parent.
2.  To verify, call getItem on your current Publication URI (e.g., 'tcm:0-99-1') and set includeProperties to ['Parents'].
3.  Inspect the 'Parents' array in the response.
4.  This will show you your Publication's true parents. Any Schemas, TTBs, Components, etc. from a parent Publication can be used when creating/updating items in the current Publication. The tools automatically map Ids to the correct Publication context, you should not need to call mapItemToContextPublication.


When providing a value for a Component Link field, the linked Component must be based on a Schema specified in that field's 'AllowedTargetSchemas' list. If you encounter a schema validation error on a component link field, use the following strategy:
- Use 'getItem' to retrieve the main Schema's definition.
- Inspect the AllowedTargetSchemas property for the specific field causing the error.
- Use the 'search' tool with the BasedOnSchemas filter to find a valid Component URI to use in the link.

To discover all available fields within an embedded schema, including optional ones, you must inspect the schema definition. Use the following strategy:
- Use getItem to retrieve the main Schema's definition.
- Locate the specific EmbeddedSchemaFieldDefinition within the Fields or MetadataFields.
- Inspect the EmbeddedFields property of that definition. This property contains a dictionary of all the fields (both mandatory and optional) that you can populate.

IMPORTANT: 
- Shared items ('BluePrintInfo.IsShared' is true) cannot be updated. To modify inherited properties, such as a Schema's fields, you must update the parent item in the BluePrint chain ('PrimaryBluePrintParentItem').
- For versioned items (Component, Schema, PageTemplate, ComponentTemplate), items that are not checked out will be automatically checked back in after updating. Items that are checked out before updating will remain checked out.
- The operation will be aborted if the item is checked out by another user.

Example 1: Update a Schema to make a mandatory field optional.
This example modifies the 'News Article' Schema (tcm:2-104-8) to include a new field, 'image'. Note that the entire 'fields' object must be provided, including the unchanged fields.

    const result = await tools.updateItemProperties({
        itemId: "tcm:2-104-8",
        itemType: "Schema",
        fields: {
            "headline": {
                "$type": "SingleLineTextFieldDefinition",
                "Name": "headline",
                "Description": "Headline",
                "MinOccurs": 1,
                "MaxOccurs": 1,
                "IsLocalizable": true
            },
            "image": {
                "$type": "MultimediaLinkFieldDefinition",
                "Name": "image",
                "Description": "Image",
                "MinOccurs": 0,
                "MaxOccurs": 1,
                "IsLocalizable": true,
                "AllowedTargetSchemas": [
                    {
                        "$type": "Link",
                        "IdRef": "tcm:2-66-8"
                    }
                ]
            },
            "articleBody": {
                "$type": "EmbeddedSchemaFieldDefinition",
                "Name": "articleBody",
                "Description": "Article Body",
                "MinOccurs": 0,
                "MaxOccurs": -1,
                "IsLocalizable": true,
                "EmbeddedSchema": {
                    "$type": "Link",
                    "IdRef": "tcm:2-102-8"
                }
            }
        }
    });

Example 2: Change the Metadata Schema of a Folder and provide the mandatory values for the new schema.
    const result = await tools.updateItemProperties({
        itemId: "tcm:5-123-2",
        itemType: "Folder",
        metadataSchemaId: "tcm:5-322-8",
        metadata: {
                    "campaignYear": 2025,
            "campaignManager": {
                "name": "Jane Doe",
                "email": "jane.doe@example.com"
            },
            "featuredProducts": [
                {
                    "productLink": {
                        "$type": "Link",
                        "IdRef": "tcm:5-801"
                    },
                    "promoText": "Early bird special!"
                },
                {
                    "productLink": {
                        "$type": "Link",
                        "IdRef": "tcm:5-802"
                    },
                    "promoText": "Limited time offer."
                }
            ]
        }
    });
`,
    input: updateItemPropertiesInputProperties,
    execute: async (params: UpdateItemPropertiesInput, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, itemType, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
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
            const itemToUpdate = getItemResponse.data;

            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.description) itemToUpdate.Description = updates.description;

            if (updates.metadataSchemaId) {
                itemToUpdate.MetadataSchema = toLink(updates.metadataSchemaId);
            }
            if (updates.metadata) {
                const schemaIdForMetadata = updates.metadataSchemaId || itemToUpdate.MetadataSchema?.IdRef;
                if (!schemaIdForMetadata || schemaIdForMetadata === 'tcm:0-0-0') throw new Error(`Could not determine a valid Schema for metadata. Please specify a 'metadataSchemaId'.`);
                convertLinksRecursively(updates.metadata, itemId);
                const orderedMetadata = await reorderFieldsBySchema(updates.metadata, schemaIdForMetadata, 'metadata', authenticatedAxios);
                itemToUpdate.Metadata = orderedMetadata;
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
                itemToUpdate.Configuration = generateSearchFolderXmlConfiguration(updates.searchQuery, updates.resultLimit || itemToUpdate.ResultLimit);
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

            const responseData = {
                $type: updatedItem['$type'],
                Id: updatedItem.Id,
                Message: `Successfully updated ${updatedItem.Id}`
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to update ${itemType} ${itemId}`);
        }
    }
};