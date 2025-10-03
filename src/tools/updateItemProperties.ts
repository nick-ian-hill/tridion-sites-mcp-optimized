import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema, fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions, reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { filterResponseData } from "../utils/responseFiltering.js";
import { handleCheckout, checkInItem, undoCheckoutItem } from "../utils/versioningUtils.js";

const activityDefinitionInputSchema = z.object({
    title: z.string().nonempty({ message: "Activity title cannot be empty." }),
    description: z.string().optional(),
    activityType: z.enum(["Normal", "Decision"]).default("Normal")
        .describe("The type of the activity. 'Normal' for a standard task, 'Decision' for a point where the workflow can branch."),
    assigneeId: z.string().regex(/^(tcm:0-\d+-(65552|65568)|tcm:0-0-0)$/).optional()
        .describe("Optional TCM URI of the User or Group to assign the activity to."),
    script: z.string().optional()
        .describe("Optional script to make this an automatic activity. For C# scripts, newlines should be represented as '\\n'."),
    scriptType: z.enum(["CSharp", "TranslationManagerActivity"]).default("CSharp")
        .describe("The scripting language used. 'CSharp' for custom automation or 'TranslationManagerActivity' for translation-related workflows."),
    nextActivities: z.array(z.string()).default([])
        .describe("An array of titles for the next activities. These titles must match the 'title' of other activities defined in this same request.")
}).refine(data => data.activityType === 'Decision' || data.nextActivities.length <= 1, {
    message: "A 'Normal' activity cannot have more than one next activity.",
});


const updateItemPropertiesInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the CMS item to update."),
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Schema", "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate", "ProcessDefinition"
    ]).describe("The type of the CMS item to update."),
    title: z.string().optional().describe("The new title for the item."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the item's metadata. Replaces the existing schema."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. May be required in the case of mandatory fields when changing the metadata schema. Replaces existing metadata."),
    activityDefinitions: z.array(activityDefinitionInputSchema).optional().describe("For Process Definition updates only. A complete array of activity definitions that will replace the existing ones."),
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
    relatedSchemaIds: z.array(z.string().regex(/^tcm:\d+-\d+-8$/)).optional().describe("For 'ComponentTemplate' type. An array of Schema TCM URIs to link to this template. Replaces any existing links."),
    includeProperties: z.array(z.string()).optional().describe(`An array of property names to include in the response object. If omitted, the full object is returned. 'Id', 'Title', and '$type' are always included when this is used.`)
};

const updateItemPropertiesSchema = z.object(updateItemPropertiesInputProperties);

type UpdateItemPropertiesInput = z.infer<typeof updateItemPropertiesSchema>;

export const updateItemProperties = {
    name: "updateItemProperties",
    description: `Updates the core properties and structural definition of an existing Content Management System (CMS) item.

This tool modifies the definition of an item itself (e.g., its title, its Schema fields, its linked templates). 
To update only the content of a Component, use the 'updateContent' tool.
To update only the metadata values of any item, use the 'updateMetadata' tool.

Example use cases by item type:
- All types: update 'title', 'description', and 'metadataSchemaId'. The 'metadata' can also be provided at the same time.
- Schema: update the content and metadata field definitions using the 'fields' and 'metadataFields' properties.
- ProcessDefinition: update the flow and properties of the workflow by providing a new 'activityDefinitions' array.
- Keyword: update 'isAbstract', 'key', 'parentKeywords', and 'relatedKeywords'.
- Bundle: update the list of 'itemsInBundle'.
- PageTemplate/ComponentTemplate: update the associated 'templateBuildingBlocks' and other template-specific properties.

When updating collection properties like 'fields', 'metadataFields', 'itemsInBundle', 'relatedSchemaIds', or 'activityDefinitions', the entire existing collection is replaced by the new value provided.

IMPORTANT: 
- Shared items ('BluePrintInfo.IsShared' is true) cannot be updated. To modify inherited properties, such as a Schema's fields, you must update the parent item in the BluePrint chain ('PrimaryBluePrintParentItem').
- For versioned items (Component, Schema, PageTemplate, ComponentTemplate), items that are not checked out will be automatically checked back in after updating. Items that are checked out before updating will remain checked out.
- If allowed, use the 'checkInItem' tool before calling 'updateItemProperties' to update an item currently checked out to a different user.

Example 1: Update a Schema to make a mandatory field optional.
This example modifies the 'News Article' Schema (tcm:2-104-8) to make the 'articleBody' embedded field optional by changing its 'MinOccurs' property from 1 to 0. Note that the entire 'fields' object must be provided, including the unchanged fields.

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
                    { "IdRef": "tcm:2-66-8" }
                ]
            },
            "articleBody": {
                "$type": "EmbeddedSchemaFieldDefinition",
                "Name": "articleBody",
                "Description": "Article Body",
                "MinOccurs": 0, // Changed from 1 to 0
                "MaxOccurs": -1,
                "IsLocalizable": true,
                "EmbeddedSchema": { "IdRef": "tcm:2-102-8" }
            }
        }
    });

Example 2: Change the Metadata Schema of a Folder and provide the metadata for the new schema. This can be neccesary when the new schema has mandatory fields.
    const result = await tools.updateItemProperties({
        itemId: "tcm:5-123-2",
        itemType: "Folder",
        metadataSchemaId: "tcm:5-321-8",
        metadata: {
            "folderType": "Campaign",
            "campaignYear": 2025
        }
    });

Example 3: Update a Process Definition to change an activity's description.
This example updates the 'Task Process' workflow. Note that the entire 'activityDefinitions' array must be provided, including all unchanged activities.

    const result = await tools.updateItemProperties({
        itemId: "tcm:5-1-131074",
        itemType: "ProcessDefinition",
        activityDefinitions: [
          {
            "title": "Perform Task",
            "description": "User performs the assigned task.",
            "assigneeId": "tcm:0-1-65568",
            "nextActivities": ["Assign to Process Creator"]
          },
          {
            "title": "Assign to Process Creator",
            "description": "Task finished. Automatically routing to the process creator for review.",
            "script": "ActivityFinishData finishData = new ActivityFinishData()\\n{\\n    Message = ProcessInstance.Activities.Last().FinishMessage,\\n    NextAssignee = new LinkToTrusteeData\\n    {\\n        IdRef = ProcessInstance.Creator.IdRef\\n    }\\n};\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": ["Review Task"]
          },
          {
            "title": "Review Task",
            "activityType": "Decision",
            "description": "Review and approve the task. Finish process or send it back.",
            "nextActivities": ["Decline", "Accept"]
          },
          {
            "title": "Decline",
            "description": "The task was reviewed and will be sent back to the performer.",
            "script": "string performedTaskActivityDefinitionId = ProcessInstance.Activities.Cast<ActivityInstanceData>().First().ActivityDefinition.IdRef;\\nActivityFinishData finishData = new ActivityFinishData()\\n{\\n    Message = ProcessInstance.Activities.Last().FinishMessage,\\n    NextAssignee = new LinkToTrusteeData\\n    {\\n        IdRef = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last(activity => activity.ActivityDefinition.IdRef == performedTaskActivityDefinitionId).Owner.IdRef\\n    }\\n};\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": ["Perform Task"]
          },
          {
            "title": "Accept",
            "description": "The task process is complete.",
            "script": "ActivityFinishData finishData = new ActivityFinishData()\\n{\\n    Message = \\"Automatic Activity 'Accept' Finished\\"\\n};\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": []
          }
        ]
    });
`,
    input: updateItemPropertiesInputProperties,
    execute: async (params: UpdateItemPropertiesInput, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, itemType, includeProperties, ...updates } = params;
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
                const versioningResult = await handleCheckout(itemId, itemToUpdate, authenticatedAxios);
                if (versioningResult.error) {
                    return { content: [{ type: "text", text: versioningResult.error }] };
                }
                itemToUpdate = versioningResult.item;
                wasCheckedOutByTool = versioningResult.wasCheckedOutByTool;
            }

            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.description) itemToUpdate.Description = updates.description;

            if (updates.metadataSchemaId) {
                itemToUpdate.MetadataSchema = toLink(updates.metadataSchemaId);
            }
            if (updates.metadata) {
                const schemaIdForMetadata = updates.metadataSchemaId || itemToUpdate.MetadataSchema?.IdRef;
                if (!schemaIdForMetadata || schemaIdForMetadata === 'tcm:0-0-0') throw new Error(`Could not determine a valid Schema for metadata. Please specify a 'metadataSchemaId'.`);
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
            if (itemType === 'ProcessDefinition' && updates.activityDefinitions) {
                const activityTitles = new Set(updates.activityDefinitions.map(a => a.title));
                for (const ad of updates.activityDefinitions) {
                    for (const nextTitle of ad.nextActivities) {
                        if (!activityTitles.has(nextTitle)) {
                            throw new Error(`Validation Error: Next activity '${nextTitle}' is defined as a transition target but does not exist as an activity title in your provided list.`);
                        }
                    }
                }
        
                itemToUpdate.ActivityDefinitions = updates.activityDefinitions.map((ad: any) => {
                    const nextActivityLinks = ad.nextActivities.map((nextTitle: string) => ({
                        "$type": "Link",
                        "IdRef": "tcm:0-0-0",
                        "Title": nextTitle
                    }));
        
                    const activityPayload: any = {
                        "$type": "TridionActivityDefinition",
                        "Id": "tcm:0-0-0",
                        "Title": ad.title,
                        "Description": ad.description,
                        "ActivityType": ad.activityType,
                        "Script": ad.script?.replace(/\\n/g, '\n'),
                        "ScriptType": ad.scriptType,
                        "NextActivityDefinitions": nextActivityLinks
                    };
        
                    if (ad.assigneeId) {
                        activityPayload.Assignee = toLink(ad.assigneeId);
                    }
        
                    return activityPayload;
                });
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
                const checkInResult = await checkInItem(itemId, authenticatedAxios);
                if (!('status' in checkInResult && checkInResult.status === 200)) {
                    return checkInResult;
                }
            }

            const finalData = filterResponseData({ responseData: updatedItem, includeProperties });

            return {
                content: [{ type: "text", text: `Successfully updated ${itemType} ${itemId}.\n\n${JSON.stringify(finalData, null, 2)}` }],
            };

        } catch (error) {
            if (isVersioned && wasCheckedOutByTool) {
                await undoCheckoutItem(itemId, authenticatedAxios);
            }
            return handleAxiosError(error, `Failed to update ${itemType} ${itemId}`);
        }
    }
};