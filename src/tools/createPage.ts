import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { linkSchema } from "../schemas/linkSchema.js";

// These constants are defined for use in helper functions and type inference.
// They are NOT used in the 'input' schema for the agent to avoid the parser limitation.

const componentPresentationSchemaForTyping = z.object({
    "$type": z.literal("ComponentPresentation"),
    Component: linkSchema,
    ComponentTemplate: linkSchema
});

// We define a recursive type for regions to help TypeScript understand the data structure.
type RegionForTyping = {
    "$type": "EmbeddedRegion";
    RegionName: string;
    Metadata?: Record<string, any>;
    ComponentPresentations?: z.infer<typeof componentPresentationSchemaForTyping>[];
    Regions?: RegionForTyping[];
};

const regionSchemaForTyping: z.ZodType<RegionForTyping> = z.lazy(() => z.object({
    "$type": z.literal("EmbeddedRegion"),
    RegionName: z.string().nonempty(),
    Metadata: z.record(fieldValueSchema).optional(),
    ComponentPresentations: z.array(componentPresentationSchemaForTyping).optional(),
    Regions: z.array(regionSchemaForTyping).optional(),
}));

// --- Helper Functions (using the schemas for typing) ---

function processComponentPresentations(
    cps: z.infer<typeof componentPresentationSchemaForTyping>[] | undefined,
    contextId: string
): any[] {
    if (!cps) return [];
    return cps.map(cp => ({
        ...cp,
        Component: toLink(convertItemIdToContextPublication(cp.Component.IdRef, contextId)),
        ComponentTemplate: toLink(convertItemIdToContextPublication(cp.ComponentTemplate.IdRef, contextId)),
    }));
}

async function processRegions(
    regions: RegionForTyping[] | undefined,
    contextId: string,
    parentSchemaId: string
): Promise<any[]> {
    if (!regions) return [];

    const processSingleRegion = async (regionData: RegionForTyping): Promise<any> => {
        const name = regionData.RegionName;
        let processedMetadata = regionData.Metadata;
        let regionSchemaIdRef: string | undefined;

        try {
            const parentSchemaResponse = await authenticatedAxios.get(`/items/${parentSchemaId.replace(':', '_')}`);
            const parentSchema = parentSchemaResponse.data;
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

        if (regionSchemaIdRef && processedMetadata) {
            processedMetadata = await reorderFieldsBySchema(processedMetadata, regionSchemaIdRef, 'content');
        }

        let nestedRegions: any[] = [];
        if (regionSchemaIdRef && regionData.Regions) {
            nestedRegions = await processRegions(regionData.Regions, contextId, regionSchemaIdRef);
        }

        const regionPayload: any = {
            "$type": "EmbeddedRegion",
            RegionName: name,
            Metadata: processedMetadata,
            ComponentPresentations: processComponentPresentations(regionData.ComponentPresentations, contextId),
            Regions: nestedRegions
        };

        if (regionSchemaIdRef) {
            regionPayload.RegionSchema = toLink(convertItemIdToContextPublication(regionSchemaIdRef, contextId));
        }
        return regionPayload;
    };

    return Promise.all(
        regions.map(regionData => processSingleRegion(regionData))
    );
}


// --- Main Tool Definition ---

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
    input: {
        title: z.string().nonempty().describe("The title for the new Page."),
        locationId: z.string().regex(/^tcm:\d+-\d+-4$/).describe("The TCM URI of the parent Structure Group where the new Page will be created."),
        fileName: z.string().nonempty().regex(/^\S+$/, "File name cannot contain white space.").describe("The file name for the page (e.g., 'about-us.html'), which cannot contain spaces."),
        pageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).describe("The TCM URI of the Page Template to be associated with the Page."),
        metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the Page's metadata. If the Page Template defines a Region Schema, and that schema defines metadata, the Region Schema will serve as the default Metadata Schema."),
        metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields, matching the Metadata Schema."),
        componentPresentations: z.string().optional().describe("A JSON string representing an array of Component Presentation objects. Each object must have '$type', 'Component' (a Link object), and 'ComponentTemplate' (a Link object). Use JSON.stringify() in code to format this correctly. If the user didn't indicate that they want to create an empty page, and none are provided, offer to include one or or more content items (Component Presentations)."),
        regions: z.string().optional().describe("A JSON string representing an array of Region objects. Each object must have '$type' and 'RegionName', and can contain 'Metadata', 'ComponentPresentations', and nested 'Regions'. Use JSON.stringify() in code or see examples.  If the user didn't indicate that they want to create an empty page, and none are provided, offer to include one or or more content items (Component Presentations)")
    },
    execute: async (args: any) => {
        const {
            title, locationId, fileName, pageTemplateId, metadataSchemaId,
            metadata, componentPresentations, regions
        } = args;

        try {
            // Parse string inputs into objects
            let parsedComponentPresentations;
            if (componentPresentations) {
                try {
                    parsedComponentPresentations = JSON.parse(componentPresentations);
                } catch (error) {
                    let errorMessage = String(error);
                    if (error instanceof Error) {
                        errorMessage = error.message;
                    }
                    return { content: [{ type: "text", text: `Error: The 'componentPresentations' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
                }
            }

            let parsedRegions;
            if (regions) {
                try {
                    parsedRegions = JSON.parse(regions);
                } catch (error) {
                    let errorMessage = String(error);
                    if (error instanceof Error) {
                        errorMessage = error.message;
                    }
                    return { content: [{ type: "text", text: `Error: The 'regions' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
                }
            }

            const contextualPageTemplateId = convertItemIdToContextPublication(pageTemplateId, locationId);
            const contextualMetadataSchemaId = metadataSchemaId ? convertItemIdToContextPublication(metadataSchemaId, locationId) : undefined;

            let processedMetadata = metadata;
            if (processedMetadata && contextualMetadataSchemaId) {
                processedMetadata = await reorderFieldsBySchema(processedMetadata, contextualMetadataSchemaId, 'metadata');
            }

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Page', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            payload.Title = title;
            payload.FileName = fileName;
            payload.PageTemplate = toLink(contextualPageTemplateId);
            if (contextualMetadataSchemaId) payload.MetadataSchema = toLink(contextualMetadataSchemaId);
            if (processedMetadata) payload.Metadata = processedMetadata;

            payload.ComponentPresentations = processComponentPresentations(parsedComponentPresentations, locationId);
            payload.Regions = await processRegions(parsedRegions, locationId, contextualPageTemplateId);

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
