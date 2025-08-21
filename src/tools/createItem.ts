import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";
import { toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

// STEP 1: Define the properties for the tool's input as a standalone object.
// This makes the schema reusable and easier to manage.
const createItemInputProperties = {
    itemType: z.enum([
        "Component", "Folder", "StructureGroup", "Keyword",
        "Category", "Page", "Bundle", "SearchFolder"
    ]).describe("The type of CMS item to create."),
    title: z.string().describe("The title for the new item."),
    locationId: z.string().regex(/^tcm:\d+-\d+-\d+$/).describe("The TCM URI of the parent container (e.g., Folder, Structure Group, Category) where the new item will be created."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Required for 'Component' and 'Page'. The TCM URI of the Schema to use for the item's content."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("Optional. The TCM URI of the Metadata Schema for the item's metadata."),
    content: z.record(fieldValueSchema).optional().describe("A JSON object for the item's content fields, structured according to its Schema. Required if the Schema has mandatory fields without default values."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields, structured according to its Metadata Schema. Required if the Metadata Schema has mandatory fields without default values."),
    fileName: z.string().optional().describe("Required for 'Page' type. The file name for the page, including the extension (e.g., 'about-us.html')."),
    pageTemplateId: z.string().optional().describe("Required for 'Page' type. The TCM URI of the Page Template to be associated with the Page."),
    isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword. Defaults to false."),
    description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, and Bundle types."),
    key: z.string().optional().describe("A custom key for the Keyword. Only applicable to Keyword type."),
    parentKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for parent Keywords. Only applicable to Keyword type."),
    relatedKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+-1024|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of URIs for related Keywords. Only applicable to Keyword type."),
    itemsInBundle: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of TCM URIs for items in the Bundle. Only applicable to Bundle type."),
    searchQuery: SearchQueryValidation.optional().describe("A search query model. This is only applicable (and must be provided) when creating a 'SearchFolder'. For SearchFolder creation, its value MUST include the 'SearchIn' property."),
    resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type")
};

// STEP 2: Create the final Zod schema and centralize validation logic using .refine().
// This keeps all validation rules in one place.
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
// This is the magic that provides full type safety and autocomplete.
type CreateItemInput = z.infer<typeof createItemInputSchema>;


// STEP 4: Define the final tool object, using the pieces we created above.
export const createItem = {
    name: "createItem",
    description: `Creates a new Content Manager System (CMS) item of a specified type.`,
    input: createItemInputProperties, // Use the properties object for the agent-facing definition

    // Use the inferred type for the 'args' parameter for full type safety. No more 'any'!
    execute: async (args: CreateItemInput) => {
        // Destructure the strongly-typed args to use them in the function
        const { itemType, title, locationId, schemaId, metadataSchemaId, content, metadata, fileName, pageTemplateId, isAbstract, description, key, parentKeywords, relatedKeywords, itemsInBundle, searchQuery, resultLimit } = args;

        console.log('SearchQuery', searchQuery);
        console.log('Creating item of type:', itemType);

        try {
            // 1. Get the default model for the item type and location from the API
            console.log('Fetching default model for', itemType, 'with container ID', locationId);
            const defaultModelResponse = await authenticatedAxios.get(`/item/defaultModel/${itemType}`, {
                params: {
                    containerId: locationId
                }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;

            // 2. Customize the payload by merging the default model with the provided arguments
            payload.Title = title;
            if (schemaId) payload.Schema = { IdRef: schemaId };
            if (metadataSchemaId) payload.MetadataSchema = { IdRef: metadataSchemaId };
            if (content) payload.Content = content;
            if (metadata) payload.Metadata = metadata;

            // Add properties specific to certain item types
            if (itemType === 'Page') {
                payload.FileName = fileName;
                payload.PageTemplate = { IdRef: pageTemplateId };
            }
            if (itemType === 'Keyword') {
                if (typeof isAbstract === 'boolean') {
                    payload.IsAbstract = isAbstract;
                }
                if (description) {
                    payload.Description = description;
                }
                if (key) {
                    payload.Key = key;
                }
                payload.ParentKeywords = toLinkArray(parentKeywords);
                payload.RelatedKeywords = toLinkArray(relatedKeywords);
            }

            if (itemType === 'SearchFolder' && searchQuery) {
                const searchInValue = searchQuery.SearchIn as any; // Using 'as any' here can be acceptable for complex, transient transformations.

                if (searchInValue && typeof searchInValue === 'object' && searchInValue.IdRef) {
                    searchQuery.SearchIn = searchInValue.IdRef;
                }
                payload.Configuration = generateSearchFolderXmlConfiguration(searchQuery, resultLimit);
                console.log('SearchFolder XML', payload.Configuration);
            }

            if (itemType === 'Bundle') {
                payload.Items = toLinkArray(itemsInBundle);
                console.log('Items in bundle', payload.Items);
            }

            console.log('parent keywords', payload.ParentKeywords);

            if ((itemType === 'Category' || itemType === 'Bundle' || itemType === 'SearchFolder') && description) {
                payload.Description = description;
            }

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
            }
            console.log('Payload', payload);

            // 3. Post the customized payload to the /items endpoint to create the item
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
            console.error('Error during item creation:', error);
            return handleAxiosError(error, "Failed to create CMS item");
        }
    }
};