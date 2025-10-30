import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively } from "../utils/fieldReordering.js";
import { processComponentPresentations, processRegions } from "../utils/pageUtils.js";

const createPageInputProperties = {
    title: z.string().nonempty().describe("The title for the new Page."),
    locationId: z.string().regex(/^tcm:\d+-\d+-4$/).describe("The TCM URI of the parent Structure Group where the new Page will be created. Use 'search' or 'getItemsInContainer' to find a Structure Group."),
    fileName: z.string().nonempty().regex(/^\S+$/, "File name cannot contain white space.").describe("The file name for the page (e.g., 'about-us.html'), which cannot contain spaces."),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the Page Template to be associated with the Page. Use 'search' or 'getItemsInContainer' to find available templates. If not provided, the page will use the Page Template defined by the parent Structure Group."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of a Schema for the Page's metadata. Use 'getSchemaLinks' to find available schemas. If the Page Template defines a Region Schema, that Region Schema can be used here."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields as defined by the schema with URI metadataSchemaId."),
    componentPresentations: z.string().optional().describe("A JSON string representing an array of Component Presentation objects. Each object must have '$type', 'Component', and 'ComponentTemplate'. Use the 'search' tool to find available Components and Component Templates. Use the 'getIsComponentTemplateRequired' tool to check if a Component Template is mandatory."),
    regions: z.string().optional().describe("A JSON string representing an array of Region objects. The RegionName for each region must match a region defined in the Page Template. To discover the correct region names and structure, first use the 'getItem' tool to inspect the 'pageTemplateId'.")
};

const createPageInputSchema = z.object(createPageInputProperties);

type CreatePageInput = z.infer<typeof createPageInputSchema>;

export const createPage = {
    name: "createPage",
    description: `Creates a new Page in the Content Management System (CMS). A Page is a container for content that is structured by a Page Template.

IMPORTANT: Before creating a Page with regions, you MUST first use the 'getItem' tool to inspect the 'pageTemplateId'. This will reveal the required region names, whether they are repeatable, and the schemas for their metadata, which is crucial for correctly formatting the 'regions' parameter.

A Page can hold content in two ways:
1.  componentPresentations: An array of Component-plus-Component-Template pairs. Use the 'getIsComponentTemplateRequired' tool to determine if the 'ComponentTemplate' is mandatory.
2.  regions: A structured way to organize content, defined by the Page Template. The Component Presentations added to a region must comply with any constraints defined in the region's schema.

If the user doesn't explicitly ask to create an empty page, you should ask if they would like to add content (Component Presentations) to the page or a region.

Examples:

Example 1: Create a simple Page with its required 'Main' region left empty.
This is a common pattern, as many Page Templates require at least one region to be specified, even if it's empty.
    const result = await tools.createPage({
        title: "Contact Us",
        locationId: "tcm:1-1-4",
        fileName: "contact.html",
        pageTemplateId: "tcm:1-15-128",
        regions: JSON.stringify([
            { "$type": "EmbeddedRegion", "RegionName": "Main" }
        ])
    });

Example 2: Create a Page with a Component Presentation on the page and an empty 'Main' region.
    const result = await tools.createPage({
        title: "Homepage",
        locationId: "tcm:1-1-4",
        fileName: "index.html",
        pageTemplateId: "tcm:1-20-128",
        componentPresentations: JSON.stringify([
            {
                "$type": "ComponentPresentation",
                "Component": { "$type": "Link", "IdRef": "tcm:1-101-16" },
                "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-102-32" }
            }
        ]),
        regions: JSON.stringify([
            { "$type": "EmbeddedRegion", "RegionName": "Main" }
        ])
    });

Example 3: Create a page with content on the page and in a region.
This demonstrates a mixed content model.
    const result = await tools.createPage({
        title: "Mixed Content Page",
        locationId: "tcm:1-1-4",
        fileName: "mixed.html",
        pageTemplateId: "tcm:1-25-128",
        componentPresentations: JSON.stringify([
            {
                "$type": "ComponentPresentation",
                "Component": { "$type": "Link", "IdRef": "tcm:1-101-16" },
                "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-102-32" }
            }
        ]),
        regions: JSON.stringify([
            {
                "$type": "EmbeddedRegion",
                "RegionName": "Main",
                "ComponentPresentations": [
                    {
                        "$type": "ComponentPresentation",
                        "Component": { "$type": "Link", "IdRef": "tcm:1-203-16" },
                        "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-204-32" }
                    }
                ]
            }
        ])
    });

Example 4: Create a complex Page with page-level metadata and nested regions.
This example shows a two-column layout within the main content area.
    const result = await tools.createPage({
        "title": "Landing Page with Columns",
        "locationId": "tcm:1-1-4",
        "fileName": "landing.html",
        "pageTemplateId": "tcm:1-30-128",
        "metadataSchemaId": "tcm:1-28-8",
        "metadata": {
            "seoTitle": "My Awesome Landing Page",
            "seoDescription": "This page is full of great content."
        },
        "regions": JSON.stringify([
            {
                "$type": "EmbeddedRegion",
                "RegionName": "MainContent",
                "Regions": [
                    {
                        "$type": "EmbeddedRegion",
                        "RegionName": "ColumnLeft",
                        "ComponentPresentations": [
                            {
                                "$type": "ComponentPresentation",
                                "Component": { "$type": "Link", "IdRef": "tcm:1-301-16" },
                                "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-302-32" }
                            }
                        ]
                    },
                    {
                        "$type": "EmbeddedRegion",
                        "RegionName": "ColumnRight",
                        "ComponentPresentations": [
                            {
                                "$type": "ComponentPresentation",
                                "Component": { "$type": "Link", "IdRef": "tcm:1-303-16" },
                                "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-304-32" }
                            }
                        ]
                    }
                ]
            }
        ])
    });`,
    input: createPageInputProperties,

    execute: async (args: CreatePageInput,
        context: any
    ) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, fileName, pageTemplateId, metadataSchemaId,
            metadata, componentPresentations, regions
        } = args;
        
        const createErrorResponse = (message: string) => {
            const errorResponse = { $type: 'Error', Message: message };
            return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }], errors: [] };
        };

        try {
            // Parse string inputs into objects early to fail fast
            let parsedComponentPresentations;
            if (componentPresentations) {
                try {
                    parsedComponentPresentations = JSON.parse(componentPresentations);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return createErrorResponse(`Error: The 'componentPresentations' parameter is not a valid JSON string. Details: ${errorMessage}`);
                }
            }

            let parsedRegions;
            if (regions) {
                try {
                    parsedRegions = JSON.parse(regions);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return createErrorResponse(`Error: The 'regions' parameter is not a valid JSON string. Details: ${errorMessage}`);
                }
            }

            // Fetch the default model to use as a base
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Page', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            // If agent provided no PT or regions, fall back to default model's regions.
            if (!pageTemplateId && !regions && payload.Regions?.length > 0) {
                parsedRegions = payload.Regions;
            }

            // Determine the definitive Page Template and Metadata Schema to use
            const defaultPageTemplateId = payload.PageTemplate?.IdRef;
            const effectivePageTemplateId = pageTemplateId || defaultPageTemplateId;
            let effectiveMetadataSchemaId = metadataSchemaId;

            // If the agent explicitly provides a pageTemplateId, the inheritance is broken.
            if (pageTemplateId) {
                payload.IsPageTemplateInherited = false;
            }

            // Use default model metadata schema ONLY if the agent didn't provide one AND
            // the effective page template is the one from the default model.
            if (!metadataSchemaId && payload.MetadataSchema?.IdRef && effectivePageTemplateId === defaultPageTemplateId) {
                effectiveMetadataSchemaId = payload.MetadataSchema.IdRef;
            }

            // If the agent specified a PT that overrides the default, and metadata/regions are missing,
            // we load the PT to inspect its PageSchema (Region Schema) for fallbacks.
            if (pageTemplateId && pageTemplateId !== defaultPageTemplateId && (!metadataSchemaId || !regions)) {
                let pageTemplate = null;
                try {
                    const ptResponse = await authenticatedAxios.get(`/items/${effectivePageTemplateId.replace(':', '_')}`);
                    if (ptResponse.status === 200) {
                        pageTemplate = ptResponse.data;
                    }
                } catch (e) {
                    console.warn(`Could not load Page Template ${effectivePageTemplateId} to inspect for fallbacks.`);
                }

                if (pageTemplate) {
                    const regionSchemaId = pageTemplate.PageSchema?.IdRef;
                    if (regionSchemaId) {
                        let regionSchema = null;
                        try {
                            const rsResponse = await authenticatedAxios.get(`/items/${regionSchemaId.replace(':', '_')}`);
                            if (rsResponse.status === 200) {
                                regionSchema = rsResponse.data;
                            }
                        } catch (e) {
                            console.warn(`Could not load Region Schema ${regionSchemaId} for fallbacks.`);
                        }

                        if (regionSchema) {
                            // If no metadata schema was provided, the Region Schema can act as one.
                            if (!metadataSchemaId) {
                                effectiveMetadataSchemaId = regionSchema.Id;
                            }

                            // If no regions were provided, check if the Region Schema defines default regions.
                            if (!regions && regionSchema.RegionDefinition?.NestedRegions?.length > 0) {
                                parsedRegions = regionSchema.RegionDefinition.NestedRegions.map((nestedRegion: any) => ({
                                    "$type": "EmbeddedRegion",
                                    "RegionName": nestedRegion.RegionName,
                                }));
                            }
                        }
                    }
                }
            }
            
            // If the agent specified a PT that overrides the default, clear the default metadata schema
            // unless a new one was determined (either from agent input or PT inspection).
            if (pageTemplateId && pageTemplateId !== defaultPageTemplateId && !effectiveMetadataSchemaId) {
                payload.MetadataSchema = undefined;
            }

            // Now, build the payload with the final, effective values
            payload.Title = title;
            payload.FileName = fileName;
            
            let contextualPageTemplateId;
            if (effectivePageTemplateId) {
                contextualPageTemplateId = convertItemIdToContextPublication(effectivePageTemplateId, locationId);
                payload.PageTemplate = toLink(contextualPageTemplateId);
            }

            let contextualMetadataSchemaId;
            if (effectiveMetadataSchemaId) {
                contextualMetadataSchemaId = convertItemIdToContextPublication(effectiveMetadataSchemaId, locationId);
                payload.MetadataSchema = toLink(contextualMetadataSchemaId);
            }

            let processedMetadata = metadata;
            if (processedMetadata) {
                convertLinksRecursively(processedMetadata, locationId);
                if (contextualMetadataSchemaId) {
                    processedMetadata = await reorderFieldsBySchema(processedMetadata, contextualMetadataSchemaId, 'metadata', authenticatedAxios);
                }
                payload.Metadata = processedMetadata;
            }

            payload.ComponentPresentations = processComponentPresentations(parsedComponentPresentations, locationId);

            if (contextualPageTemplateId) {
                payload.Regions = await processRegions(parsedRegions, locationId, contextualPageTemplateId, authenticatedAxios);
            } else if (parsedRegions && parsedRegions.length > 0) {
                return createErrorResponse(`Error: Regions were provided, but no Page Template could be determined.`);
            } else {
                payload.Regions = [];
            }

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

            const createResponse = await authenticatedAxios.post('/items', payload);
            if (createResponse.status === 201) {
                const responseData = {
                    $type: createResponse.data['$type'],
                    Id: createResponse.data.Id,
                    Message: `Successfully created ${createResponse.data.Id}`
                };
                return { 
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify(responseData, null, 2) 
                    }] 
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to create CMS item");
        }
    }
};