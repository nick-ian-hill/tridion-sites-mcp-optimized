import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLinkArray } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";
import { getCachedDefaultModel } from "../utils/defaultModelCache.js";

const createItemInputProperties = {
    itemType: z.enum([
        "Folder", "StructureGroup", "Keyword", "Category",
        "Bundle", "SearchFolder", "PageTemplate", "ComponentTemplate"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item. Note that creation will fail if an item of the same type exists in the current container (e.g., 'Folder'), or in the inherited copy of the container in a child or descendent 'Publication'. In other words, for a given container and item type, the title needs to be unique across the BluePrint hierarchy."),
    locationId: z.string().regex(/^tcm:\d+-\d+-\d+$/).describe(`The TCM URI of the parent container.
Constraints by Item Type:
- Folder, Bundle, SearchFolder, PageTemplate, ComponentTemplate -> Must be in a Folder (tcm:x-y-2).
- StructureGroup -> Must be in a Structure Group (tcm:x-y-4).
- Keyword -> Must be in a Category (tcm:x-y-512).
- Category -> Must be in a Publication (tcm:0-x-1).`),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Optional. The TCM URI of the 'Metadata' Schema (or 'Bundle' Schema for Bundles). Use 'getSchemaLinks' (with SchemaPurpose 'Metadata' or 'Bundle') to find available Schemas."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields. The order of keys in your JSON object does not matter - the tool will automatically order the fields to match the Schema definition."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, Bundle, and Search Folder types."),
    directory: z.string().optional().describe("Required for 'StructureGroup' type. The directory name used in the URL path (e.g., 'pages')."),
    key: z.string().optional().describe("A custom key for the Keyword."),
    parentKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[^:\s]+)$/)).optional().describe("An array of URIs for parent Keywords. Use 'getKeywordsForCategory' to find potential parent keywords."),
    relatedKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[^:\s]+)$/)).optional().describe("An array of URIs for related Keywords. Use 'getKeywordsForCategory' to find keywords."),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/)).optional().describe("An array of TCM URIs for items in the Bundle. Use 'search' to find items to add."),
    searchQuery: SearchQueryValidation.optional().describe("A search query model. Required when creating a 'SearchFolder'. Must include the 'SearchIn' property."),
    resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type"),
    fileExtension: z.string().optional().describe("Required for 'PageTemplate' type. The file extension (e.g., 'html')."),
    pageSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Required for 'PageTemplate' type. The TCM URI of the Page Schema (also known as a Region Schema). Use 'getSchemaLinks' with purpose 'Region' to find available schemas."),
    templateBuildingBlocks: z.array(z.string().regex(/^tcm:\d+-\d+-2048$/)).optional().describe("Optional for 'PageTemplate' and 'ComponentTemplate' types. An array of TCM URIs for Template Building Blocks. If provided, these will replace the default template content. Use 'search' with itemType 'TemplateBuildingBlock' to find available TBBs."),
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
    });

type CreateItemInput = z.infer<typeof createItemInputSchema>;

export const createItem = {
    name: "createItem",
    description: `Creates a new item in the Content Management System (CMS) of a specified type.

This is a **general-purpose creation tool** used for creating:
Folders, Structure Groups, Keywords, Categories, Bundles, Search Folders, Page Templates, and Component Templates.

## 1. Where Items Can Be Created (Container Rules)

Different item types must be created within specific container types:

- **Folders** can contain:
  - Folders
  - Bundles
  - Search Folders
  - Page Templates
  - Component Templates
  - Components (not supported by this tool. Use createComponent or one of the createMultimediaComponent tools)
  - Schemas (not supported by this tool. Use createComponentSchema, createEmbeddedSchema, createMetadataSchema, or createRegionSchema)

- **Structure Groups** can contain:
  - Structure Groups
  - Pages

- **Categories** can contain:
  - Keywords

- **Publications** can contain:
  - Root Folder
  - Root Structure Group
  - Categories

Attempting to create an item in an invalid container will result in a validation error.

## 2. BluePrint Hierarchy Conventions (Recommended Practices)

While not enforced by the tool, the following conventions are commonly used in BluePrint-based CMS setups:

- **Schema Master**
  - Schemas and Categories are typically created in a child Publication of the Root Publication.

- **Design Master**
  - Component Templates and Page Templates are usually created in a child Publication of the Schema Master.

- **Content Master**
  - Master content (Components), often in the primary language, is typically created in a sibling Publication of the Design Master.

- **Website Master**
  - Inherits from both Design Master and Content Master.
  - Contains Pages populated with Components inherited from the Content Master.

These conventions help maintain clean separation of schema, design, content, and delivery concerns.

## 3. BluePrint Context & Automatic ID Mapping (Important)

When creating an item, the tool automatically adapts referenced IDs to the BluePrint context of the target Publication ('locationId').

### How Automatic Mapping Works
- Any provided parent or dependency ID (e.g. 'metadataSchemaId', 'parentKeywords') is transformed by **replacing only the Publication ID segment** in the TCM URI.
- The tool does **not** verify whether the transformed item actually exists.

### Assumptions
- Automatic mapping works **only if** the referenced item exists in a **Parent or Ancestor Publication**.

### Common Failure Mode (404 Errors)
A 404 error will occur if the referenced item exists in a **Sibling or Child Publication** of the target publication, but not in an ancestor publication.
In this scenario, the transformed URI will not correspond to a real item in the CMS.

### How to Resolve 404 Dependency Errors
1. Verify that the referenced item exists in a Sibling or Child Publication of the target Publication.
2. If the item does exist:
   - Promote it to a common Parent Publication using 'promoteItem', or
   - Select an alternative item that already exists in the correct BluePrint context.

## 4. BluePrint Inheritance Behavior of Newly Created Items

- Any item created with this tool becomes a **Primary item** in the target Publication.
- It will be inherited as a **Shared item** by all descendant Publications (children, grandchildren, etc.).

### ID Behavior Across Publications
- The item’s numeric identifier remains the same.
- The Publication portion of the TCM URI changes per context.

**Example:**
- Created item ID: \`tcm:5-3456\`
- In Publication \`tcm:0-29-1\`, the inherited ID becomes: \`tcm:29-3456\`

## 5. Troubleshooting Component Link Validation Errors When Providing Metadata

If creation fails due to a schema validation error on a Component Link field ('ComponentLinkFieldDefinition'):

1. Use 'getItem' to retrieve the Schema definition.
2. Inspect the 'AllowedTargetSchemas' property of the failing field.
3. Use the 'search' tool with the 'BasedOnSchemas' filter to find a valid Component URI that matches one of the allowed schemas.

## 6. Validation Rules

- Creation will fail if an item of the **same type and title** already exists in the target Folder or Structure Group.

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
                    "type": "Link",
                    "IdRef": "tcm:5-1200-1024",
                },
                {
                    "type": "Link",
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
        formatForApi(args);
        const diagnosticsArgs = JSON.parse(JSON.stringify(args));
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
                validationError = `To create a '${itemType}', the 'locationId' must be a Folder (-2).
The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        } else if (itemType === 'StructureGroup') {
            if (locationTypeSuffix !== '4') {
                validationError = `To create a 'StructureGroup', the 'locationId' must be another Structure Group (-4).
The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        } else if (itemType === 'Category') {
            if (locationTypeSuffix !== '1') {
                validationError = `To create a 'Category', the 'locationId' must be a Publication (-1).
The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        } else if (itemType === 'Keyword') {
            if (locationTypeSuffix !== '512') {
                validationError = `To create a 'Keyword', the 'locationId' must be a Category (-512).
The provided 'locationId' (${locationId}) is a '${locationType}'.`;
            }
        }

        if (validationError) {
            const errorResponse = {
                type: "Error",
                Message: `Validation Error: ${validationError}`
            };
            const formattedError = formatForAgent(errorResponse);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(formattedError, null, 2)
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
        
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            // Reorder metadata fields based on schema
            if (metadata) {
                if (metadataSchemaId && metadataSchemaId !== 'tcm:0-0-0') {
                    metadata = await reorderFieldsBySchema(metadata, metadataSchemaId, 'metadata', authenticatedAxios);
                }
            }

            // 1. Get the cached default model
            let payload;
            try {
                payload = await getCachedDefaultModel(itemType, locationId, authenticatedAxios);
            } catch (error: any) {
                 return handleAxiosError(error, `Failed to load default model for ${itemType}`);
            }
            // 2. Customize the payload
            payload.Title = title;
            if (metadataSchemaId) payload.MetadataSchema = { IdRef: metadataSchemaId };
            if (metadata) payload.Metadata = metadata;
            // Type-specific properties
            if (itemType === 'PageTemplate' || itemType === 'ComponentTemplate') {
                if (templateBuildingBlocks && templateBuildingBlocks.length > 0) {
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
                        Message: `Successfully created ${createResponse.data.Id}`
                    };
                }
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedResponseData, null, 2)
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            await diagnoseBluePrintError(error, diagnosticsArgs, locationId, authenticatedAxios);
            return handleAxiosError(error, "Failed to create CMS item");
        }
    }
};