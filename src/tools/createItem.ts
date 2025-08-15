import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";
import { SearchQueryValidation } from "../schemas/searchSchema.js";
import { generateSearchFolderXmlConfiguration } from "../utils/generateSearchFolderXml.js";

export const createItem = {
    name: "createItem",
    description: `Creates a new Content Manager System (CMS) item of a specified type.`,
    input: {
        itemType: z.enum([
            "Component", "Folder", "StructureGroup", "Keyword",
            "Category", "Page", "Schema", "Bundle", "SearchFolder"
        ]).describe("The type of CMS item to create."),
        title: z.string().describe("The title for the new item."),
        locationId: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).describe("The TCM URI of the parent container (e.g., Folder, Structure Group, Category) where the new item will be created."),
        schemaId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).optional().describe("Required for 'Component' and 'Page'. The TCM URI of the Schema to use for the item's content."),
        metadataSchemaId: z.string().regex(/^(tcm):\d+-\d+(-\d+)?$/).optional().describe("Optional. The TCM URI of the Metadata Schema for the item's metadata."),
        content: z.record(z.any()).optional().describe("A JSON object for the item's content fields, structured according to its Schema. Required if the Schema has mandatory fields without default values."),
        metadata: z.record(z.any()).optional().describe("A JSON object for the item's metadata fields, structured according to its Metadata Schema. Required if the Metadata Schema has mandatory fields without default values."),
        fileName: z.string().optional().describe("Required for 'Page' type. The file name for the page, including the extension (e.g., 'about-us.html')."),
        pageTemplateId: z.string().optional().describe("Required for 'Page' type. The TCM URI of the Page Template to be associated with the Page."),
        isAbstract: z.boolean().optional().describe("Only for 'Keyword' type. Set to true to create an abstract Keyword. Defaults to false."),
        description: z.string().optional().describe("A description for the item. Applicable to Keyword, Category, and Bundle types."),
        key: z.string().optional().describe("A custom key for the Keyword. Only applicable to Keyword type."),
        parentKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of URIs for parent Keywords. Only applicable to Keyword type."),
        relatedKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of URIs for related Keywords. Only applicable to Keyword type."),
        itemsInBundle: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of TCM URIs for items in the Bundle. Only applicable to Bundle type."),
        searchQuery: SearchQueryValidation.optional().describe("A search query model. This is only applicable (and must be provided) when creating a 'SearchFolder'. For SearchFolder creation, its value MUST include the 'SearchIn' property."),
        resultLimit: z.number().int().default(100).describe("The maximum number of results to return. Only applicable to SearchFolder type")
    },
    execute: async ({ itemType, title, locationId, schemaId, metadataSchemaId, content, metadata, fileName, pageTemplateId, isAbstract, description, key, parentKeywords, relatedKeywords, itemsInBundle, searchQuery, resultLimit }: any) => {
        // Helper function to create a Link array
        const toLinkArray = (ids: string[] | undefined) => (ids && ids.length > 0 ? ids.map(id => ({ "$type": "Link", "IdRef": id })) : undefined);
        console.log('SearchQuery', searchQuery);
        console.log('Creating item of type:', itemType);
        if (!itemType) {
            console.log('No model type.');
            return { content: [], errors: [{ message: `Invalid itemType specified: ${itemType}` }] };
        }

        // Perform validation for type-specific required fields
        if (itemType === 'Page' && (!fileName || !pageTemplateId)) {
            console.log('Missing parameters for Page creation.');
            return { content: [], errors: [{ message: "To create a 'Page', both 'fileName' and 'pageTemplateId' parameters are required." }] };
        }
        if (itemType === 'Component' && !schemaId) {
            console.log('Missing parameters for Component creation.');
            return { content: [], errors: [{ message: "To create a 'Component', the 'schemaId' parameter is required." }] };
        }
        console.log('Query', searchQuery);
        if (itemType === 'SearchFolder' && !searchQuery) {
            console.log('Missing parameters for SearchFolder creation.');
            return { content: [], errors: [{ message: "To create a 'SearchFolder', the 'searchQuery' parameter is required." }] };
        }

        try {
            // 1. Get the default model for the item type and location from the API
            console.log('Fetching default model for', itemType, 'with container ID', locationId);
            const defaultModelResponse = await authenticatedAxios.get(`/item/defaultModel/${itemType}`, {
                params: {
                    containerId: locationId
                }
            });
            console.log('default model', defaultModelResponse);
            if (defaultModelResponse.status !== 200) {
                console.log('Failed to retrieve default model.');
                return { content: [], errors: [{ message: `Failed to retrieve default model. Status: ${defaultModelResponse.status}, Message: ${defaultModelResponse.statusText}` }] };
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
                // Correctly format parent and related keywords using the toLinkArray helper
                payload.ParentKeywords = toLinkArray(parentKeywords);
                payload.RelatedKeywords = toLinkArray(relatedKeywords);
            }

            // Special logic for SearchFolder
            if (itemType === 'SearchFolder' && searchQuery) {
                const searchInValue = searchQuery.SearchIn as any;

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
            // Add description for other applicable types
            if ((itemType === 'Category' || itemType === 'Bundle' || itemType === 'Schema' || itemType === 'SearchFolder') && description) {
                payload.Description = description;
            }

            // The default model should set the location, but this ensures it's correct.
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
            }
            console.log('Payload', payload);

            // 3. Post the customized payload to the /items endpoint to create the item
            const createResponse = await authenticatedAxios.post('/items', payload);

            // A successful creation returns a 201 status code
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
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status during item creation: ${createResponse.status}` },
                    ],
                };
            }

        } catch (error) {
            console.error('Error during item creation:', error);
            // Provide detailed error feedback for easier debugging by the agent
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to create CMS item: ${errorMessage}` }],
            };
        }
    }
};