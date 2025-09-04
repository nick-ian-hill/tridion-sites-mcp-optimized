import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema } from "../utils/fieldReordering.js";
import { linkSchema } from "../schemas/linkSchema.js";

// --- Schemas for TypeScript Type Inference ---
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
    description: `Creates a new Page in the Content Management System (CMS). Supports nested regions and metadata. If the user doesn't explicitly ask to create an empty page, ask them whether they would like to add content (Component Presentations) to the page or a region.`,
    input: {
        Title: z.string().nonempty().describe("The title for the new Page."),
        LocationId: z.string().regex(/^tcm:\d+-\d+-4$/).describe("The TCM URI of the parent Structure Group where the new Page will be created."),
        FileName: z.string().nonempty().regex(/^\S+$/, "File name cannot contain white space.").describe("The file name for the page (e.g., 'about-us.html'), which cannot contain spaces."),
        PageTemplateId: z.string().regex(/^tcm:\d+-\d+-128$/).describe("The TCM URI of the Page Template to be associated with the Page."),
        MetadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Metadata Schema for the Page's metadata."),
        Metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Page's metadata fields, matching the Metadata Schema."),
        ComponentPresentations: z.string().optional().describe("A JSON string representing an array of Component Presentation objects. Each object must have '$type', 'Component' (a Link object), and 'ComponentTemplate' (a Link object). Use JSON.stringify() in code to format this correctly."),
        Regions: z.string().optional().describe("A JSON string representing an array of Region objects. Each object must have '$type' and 'RegionName', and can contain 'Metadata', 'ComponentPresentations', and nested 'Regions'. Use JSON.stringify() in code or see examples.")
    },
    examples: [
        {
            description: "Create a simple Page with its required 'Main' region left empty. This is a common pattern, as many Page Templates require at least one region to be specified.",
            example: `const result = await tools.createPage({
    Title: "Contact Us",
    LocationId: "tcm:1-1-4",
    FileName: "contact.html",
    PageTemplateId: "tcm:1-15-128",
    Regions: JSON.stringify([
        { "$type": "EmbeddedRegion", "RegionName": "Main" }
    ])
});`
        },
        {
            description: "Create a Page with a Component Presentation placed directly on the page, and also include a required but empty 'Main' region.",
            example: `const result = await tools.createPage({
    Title: "Homepage",
    LocationId: "tcm:1-1-4",
    FileName: "index.html",
    PageTemplateId: "tcm:1-20-128",
    ComponentPresentations: JSON.stringify([
        {
            "$type": "ComponentPresentation",
            "Component": { "$type": "Link", "IdRef": "tcm:1-101-16" },
            "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-102-32" }
        }
    ]),
    Regions: JSON.stringify([
        { "$type": "EmbeddedRegion", "RegionName": "Main" }
    ])
});`
        },
        {
            description: "Create a page with a CP directly on the page and another CP inside the 'Main' region. This demonstrates a mixed content model.",
            example: `const result = await tools.createPage({
    Title: "Mixed Content Page",
    LocationId: "tcm:1-1-4",
    FileName: "mixed.html",
    PageTemplateId: "tcm:1-25-128",
    ComponentPresentations: JSON.stringify([
        {
            "$type": "ComponentPresentation",
            "Component": { "$type": "Link", "IdRef": "tcm:1-101-16" },
            "ComponentTemplate": { "$type": "Link", "IdRef": "tcm:1-102-32" }
        }
    ]),
    Regions: JSON.stringify([
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
});`
        },
        {
            description: "Create a complex Page with page-level metadata and nested regions (a two-column layout within the main content area).",
            example: `const result = await tools.createPage({
    "Title": "Landing Page with Columns",
    "LocationId": "tcm:1-1-4",
    "FileName": "landing.html",
    "PageTemplateId": "tcm:1-30-128",
    "MetadataSchemaId": "tcm:1-28-8",
    "Metadata": {
        "seoTitle": "My Awesome Landing Page",
        "seoDescription": "This page is full of great content."
    },
    "Regions": JSON.stringify([
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
});`
        }
    ],
    execute: async (args: any) => {
        const {
            Title, LocationId, FileName, PageTemplateId, MetadataSchemaId,
            Metadata, ComponentPresentations, Regions
        } = args;

        try {
            // Parse string inputs into objects
            let parsedComponentPresentations;
            if (ComponentPresentations) {
                try {
                    parsedComponentPresentations = JSON.parse(ComponentPresentations);
                } catch (error) {
                    let errorMessage = String(error);
                    if (error instanceof Error) {
                        errorMessage = error.message;
                    }
                    return { content: [{ type: "text", text: `Error: The 'ComponentPresentations' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
                }
            }

            let parsedRegions;
            if (Regions) {
                try {
                    parsedRegions = JSON.parse(Regions);
                } catch (error) {
                    let errorMessage = String(error);
                    if (error instanceof Error) {
                        errorMessage = error.message;
                    }
                    return { content: [{ type: "text", text: `Error: The 'Regions' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
                }
            }

            const contextualPageTemplateId = convertItemIdToContextPublication(PageTemplateId, LocationId);
            const contextualMetadataSchemaId = MetadataSchemaId ? convertItemIdToContextPublication(MetadataSchemaId, LocationId) : undefined;

            let processedMetadata = Metadata;
            if (processedMetadata && contextualMetadataSchemaId) {
                processedMetadata = await reorderFieldsBySchema(processedMetadata, contextualMetadataSchemaId, 'metadata');
            }

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Page', {
                params: { containerId: LocationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            payload.Title = Title;
            payload.FileName = FileName;
            payload.PageTemplate = toLink(contextualPageTemplateId);
            if (contextualMetadataSchemaId) payload.MetadataSchema = toLink(contextualMetadataSchemaId);
            if (processedMetadata) payload.Metadata = processedMetadata;

            payload.ComponentPresentations = processComponentPresentations(parsedComponentPresentations, LocationId);
            payload.Regions = await processRegions(parsedRegions, LocationId, contextualPageTemplateId);

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(LocationId) };
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
