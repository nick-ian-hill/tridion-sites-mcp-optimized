import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLinkArray } from "../utils/links.js";
import { linkSchema } from "../schemas/linkSchema.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

// Reusable schema for List definitions
const listDefinitionSchema = z.object({
    "$type": z.enum([
        "ListDefinition",
        "SingleLineTextListDefinition",
        "NumberListDefinition",
        "DateListDefinition"
    ]),
    Type: z.enum(["Select", "Radio", "Checkbox", "Tree"]),
    Height: z.number().int().optional(),
    Entries: z.array(z.string()).optional()
}).describe("Defines a list of predefined values for a field.");

// Base schema with common properties for all field types
const baseFieldSchema = z.object({
    Name: z.string().nonempty().describe("The machine name of the field (must match the key in the dictionary)."),
    Description: z.string().nonempty().describe("A human-readable description of the field's purpose. This field is required."),
    MinOccurs: z.number().int().optional().describe("The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory)."),
    MaxOccurs: z.number().int().optional().describe("The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value)."),
    IsIndexable: z.boolean().optional().describe("Whether the field value is included when performing a search."),
    IsLocalizable: z.boolean().optional().describe("Whether the field value can be changed in localized items."),
    IsPublishable: z.boolean().optional().describe("Whether the field value is included when publishing."),
});

// Schema for a simple text field
const singleLineTextFieldSchema = z.object({
    "$type": z.literal("SingleLineTextFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a multi-line text area
const multiLineTextFieldSchema = z.object({
    "$type": z.literal("MultiLineTextFieldDefinition")
}).merge(baseFieldSchema).extend({
    Height: z.number().int().optional().describe("The height of the text area in the UI.")
});

// Schema for a rich-text (HTML) editor
const xhtmlFieldSchema = z.object({
    "$type": z.literal("XhtmlFieldDefinition")
}).merge(baseFieldSchema).extend({
    Height: z.number().int().optional().describe("The height of the rich text editor in the UI.")
});

// Schema for a Keyword link field
const keywordFieldSchema = z.object({
    "$type": z.literal("KeywordFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a numeric field
const numberFieldSchema = z.object({
    "$type": z.literal("NumberFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a date/time field
const dateFieldSchema = z.object({
    "$type": z.literal("DateFieldDefinition")
}).merge(baseFieldSchema).extend({
    List: listDefinitionSchema.optional()
});

// Schema for a URL field
const externalLinkFieldSchema = z.object({
    "$type": z.literal("ExternalLinkFieldDefinition")
}).merge(baseFieldSchema);

// Schema for a Component link field
const componentLinkFieldSchema = z.object({
    "$type": z.literal("ComponentLinkFieldDefinition")
}).merge(baseFieldSchema).extend({
    AllowedTargetSchemas: z.array(linkSchema).optional().describe("Restricts which types of Components can be linked.")
});

// Schema for a Multimedia link field
const multimediaLinkFieldSchema = z.object({
    "$type": z.literal("MultimediaLinkFieldDefinition")
}).merge(baseFieldSchema).extend({
    AllowedTargetSchemas: z.array(linkSchema).optional().describe("Restricts which types of multimedia can be linked.")
});

// Schema for an embedded Schema field
const embeddedSchemaFieldSchema = z.object({
    "$type": z.literal("EmbeddedSchemaFieldDefinition")
}).merge(baseFieldSchema).extend({
    EmbeddedSchema: linkSchema.describe("A Link object to the Schema to be embedded.")
});

// The master schema for any valid field definition, using a discriminated union
const fieldDefinitionSchema = z.discriminatedUnion("$type", [
    singleLineTextFieldSchema,
    multiLineTextFieldSchema,
    xhtmlFieldSchema,
    keywordFieldSchema,
    numberFieldSchema,
    dateFieldSchema,
    externalLinkFieldSchema,
    componentLinkFieldSchema,
    multimediaLinkFieldSchema,
    embeddedSchemaFieldSchema
]);

export const createSchema = {
    name: "createSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema'. Schemas define the structure of content and metadata for other CMS items.

### Schema Structure
A Schema is defined by its content fields (in the 'fields' property) and metadata fields (in the 'metadataFields' property). Both of these properties are dictionaries where:
- The **key** is the field's machine name (a valid XML name without spaces, e.g., "articleTitle").
- The **value** is a Field Definition object that specifies the field's type and properties.

### Field Definition Objects
Each Field Definition object **must** include a '$type' property to identify its type from the list below. Other common properties include:
- **Name**: The machine name of the field (must match the key in the dictionary).
- **Description**: A human-readable description of the field's purpose. This is mandatory.
- **MinOccurs**: The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory).
- **MaxOccurs**: The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value).
- **IsIndexable** (Default: true) Whether the field value is included when performing a search.
- **IsLocalizable**: (Default: true) Whether the field value can be changed in localized items.
- **IsPublishable**: (Default: true) Whether the field value is included when publishing.

### Supported Field Types ('$type' values)
- **SingleLineTextFieldDefinition**: A simple text input.
- **MultiLineTextFieldDefinition**: A multi-line text area. Supports a 'Height' property for the UI.
- **XhtmlFieldDefinition**: A rich-text (HTML) editor. Supports a 'Height' property for the UI.
- **KeywordFieldDefinition**: A link to a Keyword from a Category.
- **NumberFieldDefinition**: A field for numeric values.
- **DateFieldDefinition**: A field for date/time values.
- **ExternalLinkFieldDefinition**: A field for a URL.
- **ComponentLinkFieldDefinition**: A link to another Component. Can use 'AllowedTargetSchemas' to restrict which types of Components can be linked.
- **MultimediaLinkFieldDefinition**: A link to a multimedia item (e.g., image, video). Can use 'AllowedTargetSchemas' to restrict which types of multimedia can be linked.
- **EmbeddedSchemaFieldDefinition**: Allows embedding fields from another Schema (which must have a purpose of 'Embedded'). Requires an 'EmbeddedSchema' property with a Link object (e.g., { "$type": "Link", "IdRef": "tcm:1-123-8" }).

### List Types
Some field types can be configured as lists to provide a selection of predefined values. This is done by adding a 'List' property to the field definition.
- **Supported List '$type' values**: ListDefinition (for Keywords), SingleLineTextListDefinition, NumberListDefinition, DateListDefinition.
- **List Properties**:
    - **Type**: The UI control for the list ('Select', 'Radio', 'Checkbox', 'Tree').
    - **Height**: The height of the list control in the UI.
    - **Entries**: An array of predefined values for the list.

### Purpose-Specific Properties
Certain top-level properties are only applicable when the Schema has a specific 'purpose':
- **'purpose' is 'Multimedia'**: 'allowedMultimediaTypes' can be used.
- **'purpose' is 'Bundle'**: 'deleteBundleOnProcessFinished' can be used.
- **'purpose' is 'Region'**: 'regionDefinition' can be used.`,
    input: {
        title: z.string().nonempty().describe("The title for the new Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        purpose: z.enum([
            "Component", "Multimedia", "Embedded",
            "Metadata", "Bundle", "Region"
        ]).describe("The purpose of the Schema, which determines where it can be used."),
        rootElementName: z.string().describe("The name of the root element for the XML structure defined by the Schema."),
        description: z.string().nonempty().describe("An mandatory description of the Schema."),
        fields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of field definitions for the Schema's content. The keys of the dictionary are the machine names of the fields."),
        metadataFields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of field definitions for the Schema's metadata. The keys of the dictionary are the machine names of the fields."),
        allowedMultimediaTypes: z.array(z.string().regex(/^tcm:0-\d+-65544$/)).optional().describe("An array of TCM URIs for allowed Multimedia Types. Only applicable when 'purpose' is 'Multimedia'."),
        bundleProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of a Process Definition to associate as the Bundle Process."),
        componentProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of a Process Definition to associate as the Component Process for workflow."),
        deleteBundleOnProcessFinished: z.boolean().optional().describe("If true, Bundles based on this Schema will be deleted when their workflow process finishes. Only applicable when 'purpose' is 'Bundle'."),
        isIndexable: z.boolean().optional().describe("Specifies whether Components based on this Schema will be indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether Components based on this Schema can be resolved for data publishing."),
        regionDefinition: z.string().optional().describe("The Region Definition for the Schema. Only applicable when 'purpose' is 'Region'.")
    },
    examples: [
        {
            description: "Create a simple Schema with a single, optional text field.",
            example: `const result = await tools.createSchema({
    title: "Simple Text Schema",
    locationId: "tcm:1-2-2",
    purpose: "Component",
    rootElementName: "Content",
    fields: {
        "textField": {
            "$type": "SingleLineTextFieldDefinition",
            "Name": "textField",
            "Description": "A single line of text",
            "MaxOccurs": 1,
            "MinOccurs": 0
        }
    }
});`
        },
        {
            description: "Create a more complex 'Article' Schema with both content fields and metadata fields.",
            example: `const result = await tools.createSchema({
    title: "Article",
    locationId: "tcm:1-2-2",
    purpose: "Component",
    rootElementName: "Article",
    fields: {
        "title": {
            "$type": "SingleLineTextFieldDefinition",
            "Name": "title",
            "Description": "The main title of the article.",
            "MinOccurs": 1,
            "MaxOccurs": 1
        },
        "body": {
            "$type": "XhtmlFieldDefinition",
            "Name": "body",
            "Description": "The main content of the article, which can include rich text formatting.",
            "Height": 10
        }
    },
    metadataFields: {
        "author": {
            "$type": "SingleLineTextFieldDefinition",
            "Name": "author",
            "Description": "The author of the article."
        },
        "publishDate": {
            "$type": "DateFieldDefinition",
            "Name": "publishDate",
            "Description": "The date the article was published."
        }
    }
});`
        },
        {
            description: "Create a Schema that uses another Schema for an embedded field. First, ensure you have an 'Embeddable' Schema created (e.g., a 'Date' Schema with TCM URI tcm:1-123-8).",
            example: `const result = await tools.createSchema({
    title: "Event",
    locationId: "tcm:1-2-2",
    purpose: "Component",
    rootElementName: "Event",
    fields: {
        "eventName": {
            "$type": "SingleLineTextFieldDefinition",
            "Name": "eventName",
            "Description": "The name of the event."
        },
        "eventDate": {
            "$type": "EmbeddedSchemaFieldDefinition",
            "Name": "eventDate",
            "Description": "The date of the event.",
            "EmbeddedSchema": {
                "$type": "Link",
                "IdRef": "tcm:1-123-8"
            }
        }
    }
});`
        },
        {
            description: "Create a Schema with a multi-value checkbox field using a predefined list of dates.",
            example: `const result = await tools.createSchema({
    title: "Date Selection",
    locationId: "tcm:1-2-2",
    purpose: "Component",
    rootElementName: "Dates",
    fields: {
        "availableDates": {
            "$type": "DateFieldDefinition",
            "Name": "availableDates",
            "Description": "Select your preferred dates.",
            "MaxOccurs": -1,
            "List": {
                "$type": "DateListDefinition",
                "Type": "Checkbox",
                "Entries": [
                    "2025-10-15T00:00:00",
                    "2025-10-22T00:00:00",
                    "2025-10-29T00:00:00"
                ]
            }
        }
    }
});`
        },
        {
            description: "Create a Schema with a multi-value Component Link field. This allows linking to multiple other Components. The 'MaxOccurs' property is set to -1 for unlimited values.",
            example: `const result = await tools.createSchema({
    title: "Linked Articles",
    locationId: "tcm:1-2-2",
    purpose: "Component",
    rootElementName: "Links",
    fields: {
        "relatedArticles": {
            "$type": "ComponentLinkFieldDefinition",
            "Name": "relatedArticles",
            "Description": "Links to related articles.",
            "MaxOccurs": -1,
            "AllowedTargetSchemas": [
                {
                    "$type": "Link",
                    "IdRef": "tcm:1-103-8"
                }
            ]
        }
    }
});`
        },
        {
            description: "Create a Schema with a multi-value Multimedia Link field. This allows linking to multiple multimedia items like images or videos.",
            example: `const result = await tools.createSchema({
    title: "Image Gallery",
    locationId: "tcm:1-2-2",
    purpose: "Component",
    rootElementName: "Gallery",
    fields: {
        "images": {
            "$type": "MultimediaLinkFieldDefinition",
            "Name": "images",
            "Description": "Select multiple images for the gallery.",
            "MaxOccurs": -1,
            "AllowedTargetSchemas": [
                {
                    "$type": "Link",
                    "IdRef": "tcm:1-66-8"
                }
            ]
        }
    }
});`
        }
    ],
    execute: async (args: any) => {
        const {
            title, locationId, purpose, rootElementName, description,
            fields, metadataFields, allowedMultimediaTypes, bundleProcessId,
            componentProcessId, deleteBundleOnProcessFinished, isIndexable,
            isPublishable, regionDefinition
        } = args;

        // Validation for purpose-specific fields
        if (purpose !== 'Multimedia' && allowedMultimediaTypes) {
            return { content: [{ type: "text", text: "'allowedMultimediaTypes' can only be set when the Schema 'purpose' is 'Multimedia'." }], errors: [] };
        }
        if (purpose !== 'Bundle' && typeof deleteBundleOnProcessFinished === 'boolean') {
            return { content: [{ type: "text", text: "'deleteBundleOnProcessFinished' can only be set when the Schema 'purpose' is 'Bundle'." }], errors: [] };
        }
        if (purpose !== 'Region' && regionDefinition) {
            return { content: [{ type: "text", text: "'regionDefinition' can only be set when the Schema 'purpose' is 'Region'." }], errors: [] };
        }

        try {
            // 1. Get the default model for the Schema type
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;

            // 2. Customize the payload with provided arguments
            payload.Title = title;
            payload.Purpose = purpose;
            payload.RootElementName = rootElementName;

            if (description) payload.Description = description;
            if (fields) payload.Fields = { "$type": "FieldsDefinitionDictionary", ...fields };
            if (metadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...metadataFields };

            if (allowedMultimediaTypes) payload.AllowedMultimediaTypes = toLinkArray(allowedMultimediaTypes);
            if (bundleProcessId) payload.BundleProcess = { "$type": "Link", "IdRef": bundleProcessId };
            if (componentProcessId) payload.ComponentProcess = { "$type": "Link", "IdRef": componentProcessId };

            if (typeof deleteBundleOnProcessFinished === 'boolean') payload.DeleteBundleOnProcessFinished = deleteBundleOnProcessFinished;
            if (typeof isIndexable === 'boolean') payload.IsIndexable = isIndexable;
            if (typeof isPublishable === 'boolean') payload.IsPublishable = isPublishable;

            if (regionDefinition) payload.RegionDefinition = regionDefinition;

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
            }

            // 3. Post the customized payload to create the Schema
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [{
                        type: "text",
                        text: `Successfully created Schema with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            return handleAxiosError(error, "Failed to create Schema");
        }
    }
};