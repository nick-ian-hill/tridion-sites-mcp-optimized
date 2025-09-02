import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";

// --- Zod Schemas for Input Validation ---

/**
 * Zod schema for a Component Presentation in the tool's input.
 */
const componentPresentationInputSchema = z.object({
  componentId: z.string().regex(/^tcm:\d+-\d+-16$/, "Must be a valid Component TCM URI (e.g., 'tcm:1-23-16')"),
  componentTemplateId: z.string().regex(/^tcm:\d+-\d+-32$/, "Must be a valid Component Template TCM URI (e.g., 'tcm:1-24-32')")
}).describe("A Component Presentation, which is a combination of a Component and a Component Template.");

/**
 * Zod schema for a Region in the tool's input.
 * To avoid using z.lazy(), which is not supported in the execution environment,
 * the schema is "flattened" by defining a fixed maximum nesting depth of 2 levels.
 */

const regionDescription = "A JSON object for the Region's metadata fields. The tool will automatically order the fields to match the Region's Schema definition.";
const cpDescription = "An array of Component Presentations to be placed within this Region.";
const nestedRegionDescription = "A dictionary of nested Regions within this Region. The key is the machine name of the nested Region.";

// Innermost Region Schema (allows no further nesting)
const innermostRegionSchema = z.object({
    metadata: z.record(fieldValueSchema).optional().describe(regionDescription),
    componentPresentations: z.array(componentPresentationInputSchema).optional().describe(cpDescription)
});

// Middle Region Schema (can contain innermost regions)
const middleRegionSchema = innermostRegionSchema.extend({
    regions: z.record(innermostRegionSchema).optional().describe(nestedRegionDescription)
});

// Outermost (Top-level) Region Schema for the tool's input
const regionInputSchema = innermostRegionSchema.extend({
    regions: z.record(middleRegionSchema).optional().describe(nestedRegionDescription + " Up to two levels of nesting are supported.")
});

/**
 * Zod schema defining the properties for the main tool's input.
 */
const createPageInputProperties = {
    title: z.string().nonempty().describe("The title for the new Page."),
    locationId: z.string().regex(/^tcm:\d+-\d+-4$/).describe("The TCM URI of the parent Structure Group where the new Page will be created."),
    fileName: z.string().nonempty().describe("The file name for the page (e.g., 'about-us.html'). The extension must match the one defined on the Page Template."),
    pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).describe("The TCM URI of the Page Template to be associated with the Page."),
    metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the Page's metadata."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields. The tool will automatically order the fields to match the Metadata Schema definition."),
    componentPresentations: z.array(componentPresentationInputSchema).optional().describe("An array of Component Presentations to be placed directly on the Page (not within any Region)."),
    regions: z.record(regionInputSchema).optional().describe("A dictionary of Regions for the Page. The key is the machine name of the Region. Note: This parameter is mandatory if the selected Page Template defines regions. You must provide an entry for each required region, even if it's empty (e.g., `{\"Main\": {}}`).")
};

const createPageInputSchema = z.object(createPageInputProperties);


// --- Helper Functions for Data Processing ---

/**
 * Transforms an array of Component Presentation inputs into the format required by the API.
 * @param cps - The array of Component Presentation inputs from the tool arguments.
 * @param contextId - The TCM URI of the location context (the parent Structure Group).
 * @returns An array of Component Presentation objects formatted for the API.
 */
function processComponentPresentations(
    cps: z.infer<typeof componentPresentationInputSchema>[] | undefined,
    contextId: string
): any[] {
    if (!cps) return [];
    return cps.map(cp => ({
        "$type": "ComponentPresentation",
        Component: toLink(convertItemIdToContextPublication(cp.componentId, contextId)),
        ComponentTemplate: toLink(convertItemIdToContextPublication(cp.componentTemplateId, contextId)),
    }));
}

/**
 * Recursively transforms a dictionary of Region inputs into the array format required by the API.
 * It also fetches schema information from the Page Template to correctly reorder metadata fields
 * and link the Region Schema in the payload.
 * @param regions - The dictionary of Region inputs from the tool arguments.
 * @param contextId - The TCM URI of the location context.
 * @param parentSchemaId - The TCM URI of the parent schema (Page Template or Region Schema) that defines these regions.
 * @returns A promise that resolves to an array of Region objects formatted for the API.
 */
async function processRegions(
    regions: Record<string, any> | undefined,
    contextId: string,
    parentSchemaId: string
): Promise<any[]> {
    if (!regions) return [];

    const processSingleRegion = async (name: string, regionData: any): Promise<any> => {
        let processedMetadata = regionData.metadata;
        let regionSchemaIdRef: string | undefined;

        // --- Step 1: Find the region's schema ID ---
        try {
            const parentSchemaResponse = await authenticatedAxios.get(`/items/${parentSchemaId.replace(':', '_')}`);
            const parentSchema = parentSchemaResponse.data;
            // A Page Template has a RegionSchema property. A Region Schema has a Regions property directly.
            // This logic handles both cases, which is necessary for the recursive calls.
            const regionSchemaContainer = parentSchema.RegionSchema 
                ? (await authenticatedAxios.get(`/items/${parentSchema.RegionSchema.IdRef.replace(':', '_')}`)).data 
                : parentSchema;

            const regionDef = regionSchemaContainer.Regions?.find((r: any) => r.SchemaName === name);
            if (regionDef?.RegionSchema?.IdRef) {
                regionSchemaIdRef = regionDef.RegionSchema.IdRef;
            }
        } catch (e) {
            console.warn(`Could not fetch schema info from parent ${parentSchemaId} to process Region '${name}'.`);
        }

        // --- Step 2: If schema was found, reorder metadata ---
        if (regionSchemaIdRef && processedMetadata) {
            processedMetadata = await reorderFieldsBySchema(processedMetadata, regionSchemaIdRef, 'content');
        }

        // --- Step 3: If schema was found, process nested regions ---
        let nestedRegions: any[] = [];
        if (regionSchemaIdRef) {
            nestedRegions = await processRegions(regionData.regions, contextId, regionSchemaIdRef);
        } else if (regionData.regions) {
            // Warn if user provided nested regions but we couldn't find a schema to process them with
            console.warn(`Nested regions for '${name}' will be ignored because its parent Region Schema could not be determined.`);
        }

        // --- Step 4: Build the payload ---
        const regionPayload: any = {
            "$type": "EmbeddedRegion",
            RegionName: name,
            Metadata: processedMetadata,
            ComponentPresentations: processComponentPresentations(regionData.componentPresentations, contextId),
            Regions: nestedRegions
        };

        // --- Step 5: If schema was found, add the link to the payload ---
        if (regionSchemaIdRef) {
            regionPayload.RegionSchema = toLink(convertItemIdToContextPublication(regionSchemaIdRef, contextId));
        }

        return regionPayload;
    };

    return Promise.all(
        Object.entries(regions).map(([name, regionData]) => processSingleRegion(name, regionData))
    );
}


// --- Main Tool Definition ---

export const createPage = {
    name: "createPage",
    description: `Creates a new Page in the Content Management System (CMS). This dedicated tool allows for the full composition of a Page, including its filename, Page Template, metadata, Component Presentations, and a full hierarchy of nested Regions.`,
    input: createPageInputProperties,
    examples: [
        {
            description: "Create a simple Page with its required 'Main' region left empty. This is a common pattern, as many Page Templates require at least one region to be specified.",
            example: `const result = await tools.createPage({
    title: "Contact Us",
    locationId: "tcm:1-1-4",
    fileName: "contact.html",
    pageTemplateId: "tcm:1-15-128",
    regions: {
        "Main": {}
    }
});`
        },
        {
            description: "Create a Page with a Component Presentation placed directly on the page, and also include a required but empty 'Main' region.",
            example: `const result = await tools.createPage({
    title: "Homepage",
    locationId: "tcm:1-1-4",
    fileName: "index.html",
    pageTemplateId: "tcm:1-20-128",
    componentPresentations: [
        { componentId: "tcm:1-101-16", componentTemplateId: "tcm:1-102-32" }
    ],
    regions: {
        "Main": {}
    }
});`
        },
        {
            description: "Create a page with a CP directly on the page and another CP inside the 'Main' region. This demonstrates a mixed content model.",
            example: `const result = await tools.createPage({
    title: "Mixed Content Page",
    locationId: "tcm:1-1-4",
    fileName: "mixed.html",
    pageTemplateId: "tcm:1-25-128",
    componentPresentations: [
        { componentId: "tcm:1-101-16", componentTemplateId: "tcm:1-102-32" } 
    ],
    regions: {
        "Main": {
            componentPresentations: [
                { componentId: "tcm:1-203-16", componentTemplateId: "tcm:1-204-32" }
            ]
        }
    }
});`
        },
        {
            description: "Create a complex Page with page-level metadata and nested regions (a two-column layout within the main content area).",
            example: `const result = await tools.createPage({
    title: "Landing Page with Columns",
    locationId: "tcm:1-1-4",
    fileName: "landing.html",
    pageTemplateId: "tcm:1-30-128",
    metadataSchemaId: "tcm:1-28-8",
    metadata: {
        "seoTitle": "My Awesome Landing Page",
        "seoDescription": "This page is full of great content."
    },
    regions: {
        "MainContent": {
            regions: {
                "ColumnLeft": {
                    componentPresentations: [
                        { componentId: "tcm:1-301-16", componentTemplateId: "tcm:1-302-32" }
                    ]
                },
                "ColumnRight": {
                    componentPresentations: [
                        { componentId: "tcm:1-303-16", componentTemplateId: "tcm:1-304-32" }
                    ]
                }
            }
        }
    }
});`
        }
    ],
    execute: async (args: z.infer<typeof createPageInputSchema>) => {
        let {
            title, locationId, fileName, pageTemplateId, metadataSchemaId,
            metadata, componentPresentations, regions
        } = args;

        try {
            // Convert main IDs to context publication before use
            const contextualPageTemplateId = convertItemIdToContextPublication(pageTemplateId, locationId);
            const contextualMetadataSchemaId = metadataSchemaId ? convertItemIdToContextPublication(metadataSchemaId, locationId) : undefined;

            // Reorder page metadata fields if a schema is provided
            if (metadata && contextualMetadataSchemaId) {
                metadata = await reorderFieldsBySchema(metadata, contextualMetadataSchemaId, 'metadata');
            }

            // 1. Get the default model for a Page
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Page', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            // 2. Populate the payload with provided arguments
            payload.Title = title;
            payload.FileName = fileName;
            payload.PageTemplate = toLink(contextualPageTemplateId);
            if (contextualMetadataSchemaId) payload.MetadataSchema = toLink(contextualMetadataSchemaId);
            if (metadata) payload.Metadata = metadata;

            // 3. Process and add complex properties
            payload.ComponentPresentations = processComponentPresentations(componentPresentations, locationId);
            payload.Regions = await processRegions(regions, locationId, contextualPageTemplateId);

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

            // 4. Post the payload to create the item
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully created Page with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            return handleAxiosError(error, "Failed to create Page");
        }
    }
};
