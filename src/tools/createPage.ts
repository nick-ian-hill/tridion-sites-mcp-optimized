import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { processComponentPresentations, processRegions } from "../schemas/pageSchemas.js";

// --- Main Tool Definition ---

// STEP 1: Define the properties for the tool's input as a standalone object.
const createPageInputProperties = {
    title: z.string().nonempty().describe("The title for the new Page."),
    locationId: z.string().regex(/^tcm:\d+-\d+-4$/).describe("The TCM URI of the parent Structure Group where the new Page will be created."),
    fileName: z.string().nonempty().regex(/^\S+$/, "File name cannot contain white space.").describe("The file name for the page (e.g., 'about-us.html'), which cannot contain spaces."),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).optional().describe("The TCM URI of the Page Template to be associated with the Page. If not provided, the page will use the Page Template defined by the Structure Group."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the Page's metadata. If the Page Template defines a Region Schema, and that schema defines metadata, the Region Schema will serve as the default Metadata Schema."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields, matching the Metadata Schema."),
    componentPresentations: z.string().optional().describe("A JSON string representing an array of Component Presentation objects. Each object must have '$type', 'Component' (a Link object), and 'ComponentTemplate' (a Link object). Use JSON.stringify() in code to format this correctly. If the user didn't indicate that they want to create an empty page, and none are provided, offer to include one or or more content items (Component Presentations)."),
    regions: z.string().optional().describe("A JSON string representing an array of Region objects. Each object must have '$type' and 'RegionName', and can contain 'Metadata', 'ComponentPresentations', and nested 'Regions'. Use JSON.stringify() in code or see examples.  If the user didn't indicate that they want to create an empty page, and none are provided, offer to include one or or more content items (Component Presentations). ")
};

// STEP 2: Create the final Zod schema for validation.
const createPageInputSchema = z.object(createPageInputProperties);

// STEP 3: Infer the TypeScript type directly from the schema.
type CreatePageInput = z.infer<typeof createPageInputSchema>;


// STEP 4: Define the final tool object.
export const createPage = {
    name: "createPage",
    description: `Creates a new Page in the Content Management System (CMS). A Page is a container for content that is structured by a Page Template.

IMPORTANT: Before creating a Page, you should first use the getItem tool to inspect the schema of the pageTemplateId. This will reveal the names of the required regions, whether they are repeatable, and the schemas for their metadata. This information is crucial for correctly formatting the regions parameter.

A Page can hold content in two ways:
1.  componentPresentations: An array of Component-plus-Component-Template pairs placed directly on the page, outside of any specific region.
2.  regions: A structured way to organize content. The regions parameter is a JSON string representing an array of region objects. Each region's RegionName must correspond to a region defined in the Page Template. Regions can be nested and can contain their own componentPresentations.

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

    execute: async (args: CreatePageInput) => {
        const {
            title, locationId, fileName, pageTemplateId, metadataSchemaId,
            metadata, componentPresentations, regions
        } = args;

        try {
            // Parse string inputs into objects early to fail fast
            let parsedComponentPresentations;
            if (componentPresentations) {
                try {
                    parsedComponentPresentations = JSON.parse(componentPresentations);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { content: [{ type: "text", text: `Error: The 'componentPresentations' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
                }
            }

            let parsedRegions;
            if (regions) {
                try {
                    parsedRegions = JSON.parse(regions);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { content: [{ type: "text", text: `Error: The 'regions' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
                }
            }

            // Fetch the default model to use as a base
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
                            // If no metadata schema was provided, check if the Region Schema can act as one.
                            if (!metadataSchemaId && regionSchema.MetadataFields && Object.keys(regionSchema.MetadataFields).length > 0) {
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
            if (processedMetadata && contextualMetadataSchemaId) {
                processedMetadata = await reorderFieldsBySchema(processedMetadata, contextualMetadataSchemaId, 'metadata');
            }
            if (processedMetadata) payload.Metadata = processedMetadata;

            payload.ComponentPresentations = processComponentPresentations(parsedComponentPresentations, locationId);

            if (contextualPageTemplateId) {
                payload.Regions = await processRegions(parsedRegions, locationId, contextualPageTemplateId);
            } else if (parsedRegions && parsedRegions.length > 0) {
                return { content: [{ type: "text", text: `Error: Regions were provided, but no Page Template could be determined.` }] };
            } else {
                payload.Regions = [];
            }

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

            const createResponse = await authenticatedAxios.post('/items', payload);
            if (createResponse.status === 201) {
                return { content: [{ type: "text", text: `Successfully created Page with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}` }] };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to create CMS item");
        }
    }
};
