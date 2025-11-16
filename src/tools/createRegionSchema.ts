import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { convertLinksRecursively, processSchemaFieldDefinitions, sanitizeAgentJson } from "../utils/fieldReordering.js";
import { linkSchema } from "../schemas/linkSchema.js";
import { expandableLinkSchema } from "../schemas/expandableLinkSchema.js";

// --- Zod Schemas for Region Definition ---

const occurrenceConstraintSchema = z.object({
    "$type": z.literal("OccurrenceConstraint"),
    MaxOccurs: z.number().int().describe("Maximum number of Component Presentations allowed in this Region."),
    MinOccurs: z.number().int().describe("Minimum number of Component Presentations allowed in this Region.")
});

// This schema correctly uses the standard 'linkSchema'
const typeConstraintSchema = z.object({
    "$type": z.literal("TypeConstraint"),
    BasedOnSchema: linkSchema.optional().describe("A Link to a Schema. Only Components based on this Schema are allowed."),
    BasedOnComponentTemplate: linkSchema.optional().describe("A Link to a Component Template. Only CPs with this template are allowed.")
});

const componentPresentationConstraintSchema = z.union([
    occurrenceConstraintSchema,
    typeConstraintSchema
]);

// CORRECTED: This schema now uses 'expandableLinkSchema' for the 'RegionSchema' property
const nestedRegionSchema = z.object({
    "$type": z.literal("NestedRegion"),
    RegionName: z.string().describe("The machine name of the nested Region."),
    IsMandatory: z.boolean().optional().describe("Whether this nested Region is mandatory."),
    RegionSchema: expandableLinkSchema.describe("A Link to another Region Schema that defines this nested Region. Must be an ExpandableLink.")
});

const regionDefinitionSchema = z.object({
    "$type": z.literal("RegionDefinition"),
    IsLocalizable: z.boolean().optional().describe("If set to false, Component Presentations in this Region cannot be changed in a local (child) copy of a Page. Defaults to true."),
    ComponentPresentationConstraints: z.array(componentPresentationConstraintSchema).optional()
        .describe("An array of constraints (OccurrenceConstraint, TypeConstraint) for Component Presentations in this Region."),
    NestedRegions: z.array(nestedRegionSchema).optional()
        .describe("An array of nested Region definitions.")
}).describe("A JSON object defining the Region's constraints and nested regions.");

// --- Tool Definition ---

export const createRegionSchema = {
    name: "createRegionSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Region'.
    
Region Schemas are used by Page Templates to define the layout and content areas (regions) of a Page.
This tool is the correct choice for creating the "Page Schema" that a Page Template links to.

A Region Schema can define:
1.  Constraints on the Component Presentations that can be placed within it (using '$type: "Link"').
2.  A set of nested Regions, each linking to its own Region Schema (using '$type: "ExpandableLink"').
3.  A set of metadata fields for the Region itself.
4.  Whether the Region is localizable (i.e., if its content can be overridden in child Publications).

This tool accepts the 'regionDefinition' as a direct JSON object, making it much easier to define constraints and nested regions.

IMPORTANT
- When defining a 'TypeConstraint', the 'BasedOnSchema' and 'BasedOnComponentTemplate' properties must be a Link:
  { "$type": "Link", "IdRef": "tcm:1-2-8" }
- When defining a 'NestedRegion', the 'RegionSchema' property must be an ExpandableLink:
  { "$type": "ExpandableLink", "IdRef": "tcm:1-3-8" }

Examples:

Example 1: Create a Region Schema with constraints on its Component Presentations.
    const result = await tools.createRegionSchema({
        title: "Constrained Region Schema",
        locationId: "tcm:5-2-2",
        description: "A Region that constrains what can be put inside it.",
        regionDefinition: {
            "$type": "RegionDefinition",
            "ComponentPresentationConstraints": [
                {
                    "$type": "OccurrenceConstraint",
                    "MaxOccurs": 5,
                    "MinOccurs": 0
                },
                {
                    "$type": "TypeConstraint",
                    "BasedOnSchema": { "$type": "Link", "IdRef": "tcm:5-103-8" },
                    "BasedOnComponentTemplate": { "$type": "Link", "IdRef": "tcm:5-105-32" }
                }
            ]
        }
    });
    
Example 2: Create an advanced Region Schema with a nested region.
Note the use of "$type": "ExpandableLink" for the 'RegionSchema' property inside 'NestedRegions'.
    const result = await tools.createRegionSchema({
        title: "News Page Region",
        locationId: "tcm:2-18-2",
        description: "Region Schema for a News Page, including a nested region for the main article.",
        regionDefinition: {
            "$type": "RegionDefinition",
            "ComponentPresentationConstraints": [
                {
                    "$type": "OccurrenceConstraint",
                    "MaxOccurs": 3,
                    "MinOccurs": 0
                },
                {
                    "$type": "TypeConstraint",
                    "BasedOnComponentTemplate": { "$type": "Link", "IdRef": "tcm:2-105-32" },
                    "BasedOnSchema": { "$type": "Link", "IdRef": "tcm:2-104-8" }
                }
            ],
            "NestedRegions": [
                {
                    "$type": "NestedRegion",
                    "RegionName": "Article",
                    "IsMandatory": true,
                    "RegionSchema": {
                        "$type": "ExpandableLink",
                        "IdRef": "tcm:2-181-8"
                    }
                }
            ]
        }
    });

Example 3: Create a non-localizable Region Schema.
Component Presentations placed in this Region on a Page cannot be modified in child Publications.
    const result = await tools.createRegionSchema({
        title: "Non-Localizable Header Region",
        locationId: "tcm:5-2-2",
        description: "A Region for a global header that should not be changed in local sites.",
        regionDefinition: {
            "$type": "RegionDefinition",
            "IsLocalizable": false,
            "ComponentPresentationConstraints": [
                {
                    "$type": "OccurrenceConstraint",
                    "MaxOccurs": 1,
                    "MinOccurs": 1
                }
            ]
        }
    });
    `,
    input: {
        title: z.string().nonempty().describe("The title for the new Region Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        metadataFields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of metadata field definitions for the Region Schema itself."),
        regionDefinition: regionDefinitionSchema.optional().describe("A JSON object defining the Region's constraints, nested regions, and localizability."),
        isIndexable: z.boolean().optional().describe("Specifies whether metadata values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether metadata values are published.")
    },
    execute: async (args: any, context: any) => {
        sanitizeAgentJson(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, description, metadataFields, regionDefinition,
            isIndexable, isPublishable
        } = args;
        
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const processedMetadataFields = metadataFields ? await processSchemaFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            if (processedMetadataFields) {
                convertLinksRecursively(processedMetadataFields, locationId);
            }

            if (regionDefinition) {
                convertLinksRecursively(regionDefinition, locationId);
            }

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = "Region";
            delete payload.RootElementName;

            if (description) payload.Description = description;
            if (processedMetadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
            if (regionDefinition) payload.RegionDefinition = regionDefinition;
            if (typeof isIndexable === 'boolean') payload.IsIndexable = isIndexable;
            if (typeof isPublishable === 'boolean') payload.IsPublishable = isPublishable;
            
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
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to create Region Schema");
        }
    }
};