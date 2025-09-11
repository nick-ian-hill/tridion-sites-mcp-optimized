import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLinkArray } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";

// STEP 1: Define the properties for the tool's input as a standalone object.
const createItemInputProperties = {
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item."),
    locationId: z.string().regex(/^tcm:\d+-\d+-\d+$/).describe("The TCM URI of the parent container (e.g., Folder, Structure Group, Category) where the new item will be created. For a Structure Group, the container must be a structure group. The only exception is for a Structure Group in a Publication that does not yet have a Structure Group. In this case, the createRootStructureGroup tool should be used instead. For a Category, the container must be a Publication. For keywords, the container must be a Category. For other item types the container must be a Folder."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Required for a 'Component'. The TCM URI of the Schema to use for the item's content."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Optional. The TCM URI of the Metadata Schema for the item's metadata."),
    content: z.record(fieldValueSchema).optional().describe("A JSON object for the item's content fields. The tool will automatically order the fields to match the Schema definition."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. The tool will automatically order the fields to match the Metadata Schema definition."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword. Defaults to false."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, Bundle, and Search Folder types."),
    key: z.string().optional().describe("A custom key for the Keyword. Only applicable to Keyword type."),
    parentKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for parent Keywords. Only applicable to Keyword type."),
    relatedKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for related Keywords. Only applicable to Keyword type."),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of TCM URIs for items in the Bundle. Only applicable to Bundle type."),
    searchQuery: SearchQueryValidation.optional().describe("A search query model. This is only applicable (and must be provided) when creating a 'SearchFolder'. For SearchFolder creation, its value MUST include the 'SearchIn' property."),
    resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type"),
    // Page Template specific
    fileExtension: z.string().optional().describe("The file extension for the new Page Template (e.g., 'html', 'aspx'). Required for 'PageTemplate' type."),
    pageSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Page Schema to associate with the Page Template. Required for 'PageTemplate' type."),
    // Page/Component Template specific
    templateBuildingBlocks: z.array(z.string().regex(/^tcm:\d+-\d+-2048$/)).optional().describe("An array of TCM URIs for the Template Building Blocks. Required for 'PageTemplate' and 'ComponentTemplate' types."),
    // Component Template specific
    allowOnPage: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the Component Template may be used on a Page. Defaults to true."),
    isRepositoryPublishable: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the template renders dynamic Component Presentations. Defaults to false."),
    outputFormat: z.string().optional().describe("For 'ComponentTemplate' type. The format of the rendered Component Presentation (e.g., 'HTML Fragment'). Defaults to 'HTML Fragment'."),
    priority: z.number().int().optional().describe("For 'ComponentTemplate' type. Priority used for resolving Component links. Defaults to 200."),
    relatedSchemaIds: z.array(z.string().regex(/^tcm:\d+-\d+-8$/)).optional().describe("For 'ComponentTemplate' type. An array of Schema TCM URIs this template is linked to.")
};

// STEP 2: Create the final Zod schema and centralize validation logic.
const createItemInputSchema = z.object(createItemInputProperties)
    .refine(data => !(data.itemType === 'Component' && !data.schemaId), {
        message: "To create a 'Component', the 'schemaId' parameter is required."
    })
    .refine(data => !(data.itemType === 'SearchFolder' && !data.searchQuery), {
        message: "To create a 'SearchFolder', the 'searchQuery' parameter is required."
    })
    .refine(data => !(data.itemType === 'PageTemplate' && !data.fileExtension), {
        message: "To create a 'PageTemplate', the 'fileExtension' parameter is required."
    })
    .refine(data => !(data.itemType === 'PageTemplate' && !data.pageSchemaId), {
        message: "To create a 'PageTemplate', the 'pageSchemaId' parameter is required."
    })
    .refine(data => !((data.itemType === 'PageTemplate' || data.itemType === 'ComponentTemplate') && (!data.templateBuildingBlocks || data.templateBuildingBlocks.length === 0)), {
        message: "To create a 'PageTemplate' or 'ComponentTemplate', the 'templateBuildingBlocks' parameter must be provided and not be empty."
    });

// STEP 3: Infer the TypeScript type directly from the schema.
type CreateItemInput = z.infer<typeof createItemInputSchema>;

// STEP 4: Define the final tool object.
export const createItem = {
    name: "createItem",
    description: `Creates a new Content Management System (CMS) item of a specified type.  
The tool automatically handles different item types and their specific properties.  
The item types that can be created with this tool must have a container item (Folder, Structure Group, Category, or Publication) corresponding to the locationId property.  
For a Category, the container is the Publication.  
Any references (e.g., Links) to other items—such as a metadata Schema, parent Keywords, or Component links—must refer to items in the same Publication as the container item.  
For items other than Publications, the first number in the ID identifies the Publication (e.g., for both tcm:5-127 and tcm:5-2002-2, the Publication is 5).  
For Publications, the second number identifies the Publication (e.g., tcm:0-5-1 represents Publication 5).  
Therefore, when creating a Component in the Folder with ID tcm:10-4112-2, the Schema must have an ID in the form tcm:10-###-8.`,
    input: createItemInputProperties,

    execute: async (args: CreateItemInput) => {
        const { locationId } = args;
        if (args.schemaId) {
            args.schemaId = convertItemIdToContextPublication(args.schemaId, locationId);
        }
        if (args.metadataSchemaId) {
            args.metadataSchemaId = convertItemIdToContextPublication(args.metadataSchemaId, locationId);
        }
        if (args.parentKeywords) {
            args.parentKeywords = args.parentKeywords.map(kw => convertItemIdToContextPublication(kw, locationId));
        }
        if (args.relatedKeywords) {
            args.relatedKeywords = args.relatedKeywords.map(kw => convertItemIdToContextPublication(kw, locationId));
        }
        if (args.itemsInBundle) {
            args.itemsInBundle = args.itemsInBundle.map(item => convertItemIdToContextPublication(item, locationId));
        }
        if (args.pageSchemaId) {
            args.pageSchemaId = convertItemIdToContextPublication(args.pageSchemaId, locationId);
        }
        if (args.templateBuildingBlocks) {
            args.templateBuildingBlocks = args.templateBuildingBlocks.map(tbb => convertItemIdToContextPublication(tbb, locationId));
        }
        if (args.relatedSchemaIds) {
            args.relatedSchemaIds = args.relatedSchemaIds.map(id => convertItemIdToContextPublication(id, locationId));
        }
        // Recursively convert links in content and metadata
        if (args.content) {
            convertLinksRecursively(args.content, locationId);
        }
        if (args.metadata) {
            convertLinksRecursively(args.metadata, locationId);
        }

        let { itemType, title, schemaId, metadataSchemaId, content, metadata, isAbstract, description, key, parentKeywords, relatedKeywords, itemsInBundle, searchQuery, resultLimit = 100, fileExtension, pageSchemaId, templateBuildingBlocks, allowOnPage, isRepositoryPublishable, outputFormat, priority, relatedSchemaIds } = args;

        try {
            // Reorder content and metadata fields based on their respective schemas
            if (content && schemaId) {
                content = await reorderFieldsBySchema(content, schemaId, 'content');
            }
            if (metadata) {
                if (metadataSchemaId && metadataSchemaId !== 'tcm:0-0-0') {
                    metadata = await reorderFieldsBySchema(metadata, metadataSchemaId, 'metadata');
                }
                else if (schemaId) {
                    metadata = await reorderFieldsBySchema(metadata, schemaId, 'metadata');
                }
            }

            // 1. Get the default model for the item type and location
            const defaultModelResponse = await authenticatedAxios.get(`/item/defaultModel/${itemType}`, {
                params: {
                    containerId: locationId
                }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            // 2. Customize the payload
            payload.Title = title;
            if (schemaId) payload.Schema = { IdRef: schemaId };
            if (metadataSchemaId) payload.MetadataSchema = { IdRef: metadataSchemaId };
            if (content) payload.Content = content;
            if (metadata) payload.Metadata = metadata;

            // Type-specific properties
            if (itemType === 'PageTemplate' || itemType === 'ComponentTemplate') {
                if (templateBuildingBlocks) {
                    const tbbInvocations = templateBuildingBlocks.map(tbbId =>
                        `<TemplateInvocation><Template xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${tbbId}" xlink:title="" /></TemplateInvocation>`
                    ).join('');
                    payload.Content = `<CompoundTemplate xmlns="http://www.tridion.com/ContentManager/5.3/CompoundTemplate">${tbbInvocations}</CompoundTemplate>`;
                }
            }
            if (itemType === 'PageTemplate') {
                if (pageSchemaId) payload.PageSchema = { IdRef: pageSchemaId };
                if (fileExtension) payload.FileExtension = fileExtension;
            }
            if (itemType === 'ComponentTemplate') {
                payload.AllowOnPage = allowOnPage ?? true;
                payload.IsRepositoryPublishable = isRepositoryPublishable ?? false;
                payload.OutputFormat = outputFormat ?? "HTML Fragment";
                payload.Priority = priority ?? 200;
                if (relatedSchemaIds) payload.RelatedSchemas = toLinkArray(relatedSchemaIds);
            }
            if (itemType === 'Keyword') {
                if (typeof isAbstract === 'boolean') payload.IsAbstract = isAbstract;
                if (description) payload.Description = description;
                if (key) payload.Key = key;
                payload.ParentKeywords = toLinkArray(parentKeywords);
                payload.RelatedKeywords = toLinkArray(relatedKeywords);
            }
            if (itemType === 'SearchFolder' && searchQuery) {
                const searchInValue = searchQuery.SearchIn as any;
                if (searchInValue && typeof searchInValue === 'object' && searchInValue.IdRef) {
                    searchQuery.SearchIn = searchInValue.IdRef;
                }

                // Ensure all URIs within the search query are mapped to the correct publication context.
                if (searchQuery.SearchIn) {
                    const contextId = searchQuery.SearchIn;

                    if (searchQuery.BasedOnSchemas) {
                        searchQuery.BasedOnSchemas = searchQuery.BasedOnSchemas.map(schemaFilter => ({
                            ...schemaFilter,
                            schemaUri: convertItemIdToContextPublication(schemaFilter.schemaUri, contextId)
                        }));
                    }

                    if (searchQuery.UsedKeywords) {
                        searchQuery.UsedKeywords = searchQuery.UsedKeywords.map(keywordUri =>
                            convertItemIdToContextPublication(keywordUri, contextId)
                        );
                    }

                    if (searchQuery.ActivityDefinition) {
                        searchQuery.ActivityDefinition = convertItemIdToContextPublication(searchQuery.ActivityDefinition, contextId);
                    }

                    if (searchQuery.ProcessDefinition) {
                        searchQuery.ProcessDefinition = convertItemIdToContextPublication(searchQuery.ProcessDefinition, contextId);
                    }
                }

                payload.Configuration = generateSearchFolderXmlConfiguration(searchQuery, resultLimit);
            }
            if (itemType === 'Bundle') {
                payload.Items = toLinkArray(itemsInBundle);
            }
            if ((itemType === 'Category' || itemType === 'Bundle' || itemType === 'SearchFolder') && description) {
                payload.Description = description;
            }
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
            }

            // 3. Post the payload to create the item
            const createResponse = await authenticatedAxios.post('/items', payload);
            if (createResponse.status === 201) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully created ${itemType} with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to create CMS item");
        }
    }
};