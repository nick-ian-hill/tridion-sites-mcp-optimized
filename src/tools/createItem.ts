import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLinkArray } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";

// STEP 1: Define the properties for the tool's input as a standalone object.
const createItemInputProperties = {
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Page", "Bundle", "SearchFolder"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item."),
    locationId: z.string().regex(/^tcm:\d+-\d+-\d+$/).describe("The TCM URI of the parent container (e.g., Folder, Structure Group, Category) where the new item will be created."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Required for 'Component' and 'Page'. The TCM URI of the Schema to use for the item's content."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Optional. The TCM URI of the Metadata Schema for the item's metadata."),
    content: z.record(fieldValueSchema).optional().describe("A JSON object for the item's content fields. The tool will automatically order the fields to match the Schema definition."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. The tool will automatically order the fields to match the Metadata Schema definition."),
    fileName: z.string().optional().describe("Required for 'Page' type. The file name for the page, including the extension (e.g., 'about-us.html')."),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("Required for 'Page' type. The TCM URI of the Page Template to be associated with the Page."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword. Defaults to false."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, and Bundle types."),
    key: z.string().optional().describe("A custom key for the Keyword. Only applicable to Keyword type."),
    parentKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for parent Keywords. Only applicable to Keyword type."),
    relatedKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for related Keywords. Only applicable to Keyword type."),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of TCM URIs for items in the Bundle. Only applicable to Bundle type."),
    searchQuery: SearchQueryValidation.optional().describe("A search query model. This is only applicable (and must be provided) when creating a 'SearchFolder'. For SearchFolder creation, its value MUST include the 'SearchIn' property."),
    resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type")
};

// STEP 2: Create the final Zod schema and centralize validation logic.
const createItemInputSchema = z.object(createItemInputProperties)
    .refine(data => !(data.itemType === 'Page' && (!data.fileName || !data.pageTemplateId)), {
        message: "To create a 'Page', both 'fileName' and 'pageTemplateId' parameters are required."
    })
    .refine(data => !(data.itemType === 'Component' && !data.schemaId), {
        message: "To create a 'Component', the 'schemaId' parameter is required."
    })
    .refine(data => !(data.itemType === 'SearchFolder' && !data.searchQuery), {
        message: "To create a 'SearchFolder', the 'searchQuery' parameter is required."
    });

// STEP 3: Infer the TypeScript type directly from the schema.
type CreateItemInput = z.infer<typeof createItemInputSchema>;

// STEP 4: Define the final tool object.
export const createItem = {
    name: "createItem",
    description: `Creates a new Content Manager System (CMS) item of a specified type. The tool handles different item types and their specific properties automatically.`,
    input: createItemInputProperties,

    execute: async (args: CreateItemInput) => {
        const { locationId } = args;
        if (args.schemaId) {
            args.schemaId = convertItemIdToContextPublication(args.schemaId, locationId);
        }
        if (args.metadataSchemaId) {
            args.metadataSchemaId = convertItemIdToContextPublication(args.metadataSchemaId, locationId);
        }
        if (args.pageTemplateId) {
            args.pageTemplateId = convertItemIdToContextPublication(args.pageTemplateId, locationId);
        }
        if (args.parentKeywords) {
            args.parentKeywords = args.parentKeywords.map(kw => convertItemIdToContextPublication(kw, locationId));
        }
        if (args.relatedKeywords) {
            args.relatedKeywords = args.relatedKeywords.map(kw => convertItemIdToContextPublication(kw, locationId));
        }

        let { itemType, title, schemaId, metadataSchemaId, content, metadata, fileName, pageTemplateId, isAbstract, description, key, parentKeywords, relatedKeywords, itemsInBundle, searchQuery, resultLimit } = args;

        try {
            // Reorder content and metadata fields based on their respective schemas
            if (content && schemaId) {
                content = await reorderFieldsBySchema(content, schemaId, 'content');
            }
            if (metadata && metadataSchemaId) {
                metadata = await reorderFieldsBySchema(metadata, metadataSchemaId, 'metadata');
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
            if (itemType === 'Page') {
                payload.FileName = fileName;
                payload.PageTemplate = { IdRef: pageTemplateId };
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