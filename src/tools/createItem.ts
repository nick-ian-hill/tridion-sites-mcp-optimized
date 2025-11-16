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
        "Folder", "StructureGroup", "Keyword", "Category",
        "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item. Note that creation will fail if an item of the same type exists in the current container (e.g., 'Folder'), or in the inherited copy of the container in a child or descendent 'Publication'. In other words, for a given container and item type, the title needs to be unique across the BluePrint hierarchy."),
    locationId: z.string().regex(/^tcm:\d+-\d+-\d+$/).describe("The TCM URI of the parent container. Use 'search' or 'getItemsInContainer' to find a suitable container. For 'Keyword', the container must be a Category (use 'getCategories'). For 'Category', the container is a Publication (use 'getPublications')."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Optional. The TCM URI of the Metadata Schema. Use 'getSchemaLinks' to find available Schemas."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. The order of keys in your JSON object does not matter - the tool will automatically order the fields to match the Schema definition."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, Bundle, and Search Folder types."),
    directory: z.string().optional().describe("Required for 'StructureGroup' type. The directory name used in the URL path (e.g., 'pages')."),
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
    .refine(data => !(data.itemType === 'StructureGroup' && !data.directory), {
        message: "To create a 'StructureGroup', the 'directory' parameter is required."
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
    description: `Creates a new Content Manager System (CMS) item of a specified type.
This is a general-purpose creation tool for Folders, Structure Groups, Keywords, Categories, Bundles, etc.
To create a Component, use the dedicated 'createComponent' tool.
To create a Multimedia Component, use 'createMultimediaComponentFromPrompt', 'createMultimediaComponentFromUrl', or 'createMultimediaComponentFromBase64'.

The tool automatically handles different item types and their specific properties. The created item will be placed in the container (Folder, Structure Group, Category, or Publication) specified by 'locationId'. Note that a Publication can only have one root Folder and one root Structure Group. A Folder/structure Group can contain arbitrarily many child Folders/Structure Groups.
For a Category, the container is the Publication.
For Keywords, the container must be a Category.
For Folders, Bundles, SearchFolders, PageTemplates and ComponentTemplates the container must be a Folder.
For StructureGroups the container must be another StructureGroup.
For items other than Publications, the first number in the ID identifies the Publication (e.g., for both tcm:5-127 and tcm:5-2002-2, the Publication is 5).
For Publications, the second number identifies the Publication (e.g., tcm:0-5-1 represents Publication 5).

Notes on BluePrint structure in relation to content creation:
You would typically not create content or design related items in the root Publication. Instead, content-related schemas (schemas with purpose 'Component' or 'Embedded') and Categories used for classifying content would typically be created in a direct child Publication of the root (e.g., 'Schema Master'). Creating Categories and content Schemas in the same Publication ensures that any 'KeywordFieldDefinition' fields can reference a relevant Catgory.
Items related to how content is rendered (Component Templates, Page Templates, Template Building Blocks, and Region Schemas) are commonly created in a second direct child of the root Publication (e.g., 'Design Master'). As siblings, 'Schema Master' and 'Design Master' do not have access to each other's items.
The main content Components would typically be created in a 'Content Master' Publication having both the 'Schema Master' and 'Design Master' Publications as parents. Items (Schemas, Templates etc.) from both Publications would be available (via inheritance) in 'Content Master'.

BluePrint Context & 404 Errors:
Any ID parameters you provide (e.g., 'metadataSchemaId', 'pageSchemaId', 'parentKeywords') MUST exist in the same Publication as 'locationId'.
If any IDs reference items in a parent or other ancestor Publication, the items will be inherited by the context Publication, and the tool will map the IDs to the correct context automatically.
For example, if you are in 'locationId' "tcm:107-..." (Child) and reference a metadataSchema from "tcm:105-..." (Parent), the tool correctly maps this to the inherited ID "tcm:107-...".
As a result of the automatic mapping, you do not need to use the 'mapItemToContextPublication' tool for mapping purposes.

If you get a 404 'Not Found' error for an item you trying to reference (e.g., a Keyword) it likely means the item is in a sibling or child Publication, not a parent or other ancestor.
Items created in sibling/child Pubications are not inherited, and therefore the mapped ID will not correspond to a real item.

In this scenario, you will either need to
- find an alternative item that already exists in the context Publication,
- create a new item in the context Publication or a parent/ancestor, or
- promote the item(s) you are trying to reference to a parent or ancestor Publication using the 'promoteItem' tool.

To find the parent Publications, call getItem on your current Publication URI (e.g., 'tcm:0-99-1') and set includeProperties to ['Parents'].

When populating a Component Link field (ComponentLinkFieldDefinition), the linked Component must be based on a Schema specified in that field's 'AllowedTargetSchemas' list. If you encounter a schema validation error on a component link field, use the following strategy:
- Use 'getItem' to retrieve the main Schema's definition.
- Inspect the AllowedTargetSchemas property for the specific field causing the error.
- Use the 'search' tool with the BasedOnSchemas filter to find a valid Component URI to use in the link.

Important: Creation will fail with a '409 Conflict' error if an item of the same type and with the same title already exists in the target location or its BluePrint context (e.g. a child Publication).

Examples:

Example 1: Create a Folder for a campaign.
    const result = await tools.createItem({
        itemType: "Folder",
        locationId: "tcm:5-53-2",
        title: "Campaigns",
        metadataSchemaId: "tcm:5-984-8",
        metadata: {
            "Regions": [
                {
                    "$type": "Link",
                    "IdRef": "tcm:5-1200-1024",
                },
                {
                    "$type": "Link",
                    "IdRef": "tcm:5-1201-1024",
                }
            ]
        }
    });

Example 2: Create a new Category in a Publication. If used for classifying content, the selected publication should be the "master" content publication or one of its parents/ancestors.
    const result = await tools.createItem({
        itemType: "Category",
        locationId: "tcm:0-5-1", // ID of the Publication
        title: "News Categories",
        description: "A category for classifying news articles."
    });

Example 3: Create a new Keyword.
    const result = await tools.createItem({
        itemType: "Keyword",
        locationId: "tcm:5-123-512",
        title: "New Product",
        description: "Keyword for new products.",
        key: "NEW_PRODUCT"
    });
`,
    input: createItemInputProperties,

    execute: async (args: CreateItemInput,
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { locationId, itemType } = args;

        const locationTypeSuffix = locationId.split('-').pop();

        const typeMap: { [key: string]: string } = {
            '1': 'Publication',
            '2': 'Folder',
            '4': 'StructureGroup',
            '512': 'Category',
            '1024': 'Keyword'
        };
        const locationType = typeMap[locationTypeSuffix ?? ''] || `Unknown (suffix: -${locationTypeSuffix})`;

        const containerMustBeFolder = [
            "Folder", "Bundle", "SearchFolder",
            "PageTemplate", "ComponentTemplate"
        ];

        let validationError: string | null = null;

        if (containerMustBeFolder.includes(itemType)) {
            if (locationTypeSuffix !== '2') {
                validationError = `To create a '${itemType}', the 'locationId' must be a Folder (-2). The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        } else if (itemType === 'StructureGroup') {
            if (locationTypeSuffix !== '4') {
                validationError = `To create a 'StructureGroup', the 'locationId' must be another Structure Group (-4). The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        } else if (itemType === 'Category') {
            if (locationTypeSuffix !== '1') {
                validationError = `To create a 'Category', the 'locationId' must be a Publication (-1). The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        } else if (itemType === 'Keyword') {
            if (locationTypeSuffix !== '512') {
                validationError = `To create a 'Keyword', the 'locationId' must be a Category (-512). The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        }

        if (validationError) {
            return {
                content: [{
                    type: "text",
                    text: `Validation Error: ${validationError}`
                }],
            };
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
        if (args.metadata) {
            convertLinksRecursively(args.metadata, locationId);
        }

        let { title, metadataSchemaId, metadata, isAbstract, description, key, parentKeywords, relatedKeywords, itemsInBundle, searchQuery, resultLimit = 100, fileExtension, pageSchemaId, templateBuildingBlocks, allowOnPage, isRepositoryPublishable, outputFormat, priority, relatedSchemaIds, directory } = args;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            // Reorder metadata fields based on schema
            if (metadata) {
                if (metadataSchemaId && metadataSchemaId !== 'tcm:0-0-0') {
                    metadata = await reorderFieldsBySchema(metadata, metadataSchemaId, 'metadata', authenticatedAxios);
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
            if (metadataSchemaId) payload.MetadataSchema = { IdRef: metadataSchemaId };
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
            if (itemType === 'StructureGroup' && directory) {
                payload.Directory = directory;
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
                let responseData;
                if (createResponse.data) {
                    responseData = {
                        $type: createResponse.data['$type'],
                        Id: createResponse.data.Id,
                        Message:`Successfully created ${createResponse.data.Id}`
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(responseData, null, 2)
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