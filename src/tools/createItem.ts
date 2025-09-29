import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLinkArray } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";

const createItemInputProperties = {
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item."),
    locationId: z.string().regex(/^tcm:\d+-\d+-\d+$/).describe("The TCM URI of the parent container. Use 'search' or 'getItemsInContainer' to find a suitable container. For 'Keyword', the container must be a Category (use 'getCategories'). For 'Category', the container is a Publication (use 'getPublications')."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Required for 'Component'. The TCM URI of the Schema. Use 'getSchemaLinks' to find available Schemas in the target Publication."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Optional. The TCM URI of the Metadata Schema. Use 'getSchemaLinks' to find available Schemas."),
    content: z.record(fieldValueSchema).optional().describe("A JSON object for the item's content fields. The tool will automatically order the fields to match the Schema definition."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. The tool will automatically order the fields to match the Schema definition."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, Bundle, and Search Folder types."),
    key: z.string().optional().describe("A custom key for the Keyword."),
    parentKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for parent Keywords. Use 'getKeywordsForCategory' to find potential parent keywords."),
    relatedKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for related Keywords. Use 'getKeywordsForCategory' to find keywords."),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of TCM URIs for items in the Bundle. Use 'search' to find items to add."),
    searchQuery: SearchQueryValidation.optional().describe("A search query model. Required when creating a 'SearchFolder'. Must include the 'SearchIn' property."),
    resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type"),
    fileExtension: z.string().optional().describe("Required for 'PageTemplate' type. The file extension (e.g., 'html')."),
    pageSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Required for 'PageTemplate' type. The TCM URI of the Page Schema (also known as a Region Schema). Use 'getSchemaLinks' with purpose 'Region' to find available schemas."),
    templateBuildingBlocks: z.array(z.string().regex(/^tcm:\d+-\d+-2048$/)).optional().describe("Required for 'PageTemplate' and 'ComponentTemplate' types. An array of TCM URIs for Template Building Blocks. Use 'search' with itemType 'TemplateBuildingBlock' to find available TBBs."),
    allowOnPage: z.boolean().optional().describe("For 'ComponentTemplate' type. Defaults to true."),
    isRepositoryPublishable: z.boolean().optional().describe("For 'ComponentTemplate' type. Whether the template renders dynamic Component Presentations. Defaults to false."),
    outputFormat: z.string().optional().describe("For 'ComponentTemplate' type. Defaults to 'HTML Fragment'."),
    priority: z.number().int().optional().describe("For 'ComponentTemplate' type. Defaults to 200."),
    relatedSchemaIds: z.array(z.string().regex(/^tcm:\d+-\d+-8$/)).optional().describe("For 'ComponentTemplate' type. An array of Schema TCM URIs this template is linked to. Use 'getSchemaLinks' to find schemas.")
};

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

type CreateItemInput = z.infer<typeof createItemInputSchema>;

export const createItem = {
    name: "createItem",
    description: `Creates a new Content Management System (CMS) item of a specified type. This is a general-purpose creation tool. For more specific creation tasks, consider using 'createPage', 'createPublication', 'createSchema', or 'createMultimediaComponentFromUrl'.
The tool automatically handles different item types and their specific properties. The created item will be placed in the container (Folder, Structure Group, Category, or Publication) specified by 'locationId'. Any references to other items (e.g., a Schema, parent Keywords) must be in the same Publication as the container item.
For a Category, the container is the Publication.   
For items other than Publications, the first number in the ID identifies the Publication (e.g., for both tcm:5-127 and tcm:5-2002-2, the Publication is 5).  
For Publications, the second number identifies the Publication (e.g., tcm:0-5-1 represents Publication 5).  
Therefore, when creating a Component in the Folder with ID tcm:10-4112-2, the Schema must have an ID in the form tcm:10-###-8.`,
    input: createItemInputProperties,

    execute: async (args: CreateItemInput,
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

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
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            // Reorder content and metadata fields based on their respective schemas
            if (content && schemaId) {
                content = await reorderFieldsBySchema(content, schemaId, 'content', authenticatedAxios);
            }
            if (metadata) {
                if (metadataSchemaId && metadataSchemaId !== 'tcm:0-0-0') {
                    metadata = await reorderFieldsBySchema(metadata, metadataSchemaId, 'metadata', authenticatedAxios);
                }
                else if (schemaId) {
                    metadata = await reorderFieldsBySchema(metadata, schemaId, 'metadata', authenticatedAxios);
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