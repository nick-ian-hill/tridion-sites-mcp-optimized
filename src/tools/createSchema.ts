import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { xmlNameSchema } from "../schemas/xmlNameSchema.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions } from "../utils/fieldReordering.js";

export const createSchema = {
    name: "createSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema'. Schemas define the structure of content and metadata for other CMS items.
    
A Schema is defined by its content fields (in the 'fields' property) and metadata fields (in the 'metadataFields' property). Both of these properties are dictionaries where:
  - The KEY is the field's machine name (a valid XML name without spaces, e.g., "articleTitle").
  - The VALUE is a Field Definition object that specifies the field's type and properties.

Each Field Definition object MUST include a '$type' property to identify its type from the list below. Other common properties include:
  - Name: The machine name of the field (must match the key in the dictionary).
  - Description: A human-readable description of the field's purpose. This is mandatory.
  - MinOccurs: The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory).
  - MaxOccurs: The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value).
  - IsIndexable (Default: true): Whether the field value is included when performing a search.
  - IsLocalizable (Default: true): Whether the field value can be changed in localized items.
  - IsPublishable (Default: true): Whether the field value is included when publishing.

Supported Field Types ('$type' values):
  - SingleLineTextFieldDefinition: A simple text input.
  - MultiLineTextFieldDefinition: A multi-line text area. Supports a 'Height' property for the UI.
  - XhtmlFieldDefinition: A rich-text (HTML) editor. Supports a 'Height' property for the UI. Can also include a 'FormattingFeatures' object to control the editor's toolbar.
  - KeywordFieldDefinition: A link to a Keyword from a Category.
  - NumberFieldDefinition: A field for numeric values.
  - DateFieldDefinition: A field for date/time values.
  - ExternalLinkFieldDefinition: A field for a URL.
  - ComponentLinkFieldDefinition: A link to another Component. Can use 'AllowedTargetSchemas' to restrict which types of Components can be linked.
  - MultimediaLinkFieldDefinition: A link to a multimedia item (e.g., image, video). Can use 'AllowedTargetSchemas' to restrict which types of multimedia can be linked.
  - EmbeddedSchemaFieldDefinition: Allows embedding fields from another Schema (which must have a purpose of 'Embedded'). Requires an 'EmbeddedSchema' property with a Link object (e.g., { "$type": "Link", "IdRef": "tcm:1-123-8" }).

Some field types can be configured as lists to provide a selection of predefined values. This is done by adding a 'List' property to the field definition.
  - Supported List '$type' values: ListDefinition (for Keywords), SingleLineTextListDefinition, NumberListDefinition, DateListDefinition.
  - List Properties:
      - Type: The UI control for the list ('Select', 'Radio', 'Checkbox', 'Tree').
      - Height: The height of the list control in the UI.
      - Entries: An array of predefined values for the list.

Certain top-level properties are only applicable when the Schema has a specific 'purpose':
  - 'purpose' is 'Multimedia': 'allowedMultimediaTypes' can be used.
  - 'purpose' is 'Bundle': 'deleteBundleOnProcessFinished' can be used.
  - 'purpose' is 'Region': 'regionDefinition' can be used.

Examples:

Example 1: Create a simple Schema with a single, optional text field.
    const result = await tools.createSchema({
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
    });

Example 2: Create a more complex 'Article' Schema with both content fields and metadata fields.
    const result = await tools.createSchema({
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
    });

Example 3: Create a Schema with an XHTML field that has custom formatting features, disabling several toolbar buttons.
    const result = await tools.createSchema({
        title: "Rich Text Schema with Custom Formatting",
        locationId: "tcm:1-2-2",
        purpose: "Component",
        rootElementName: "RichText",
        fields: {
            "formattedContent": {
                "$type": "XhtmlFieldDefinition",
                "Name": "formattedContent",
                "Description": "Rich text content with a restricted toolbar.",
                "Height": 15,
                "FormattingFeatures": {
                    "$type": "FormattingFeatures",
                    "DocType": "Strict",
                    "DisallowedActions": [
                        "Strikethrough",
                        "Subscript",
                        "Superscript",
                        "AlignLeft",
                        "Center",
                        "AlignRight"
                    ]
                }
            }
        }
    });

Example 4: Create a Schema that uses an embeddable Schema for an embedded field. First, ensure you have an 'Embeddable' Schema created (e.g., an 'Author' Schema with TCM URI tcm:1-123-8). The embeddable Schema will be referenced via the 'EmbeddedSchema' property, the value of which should be a Link. There should also be an EmbeddedFields property, the value of which should be an empty object.
    const result = await tools.createSchema({
        title: "ArticleSchema",
        locationId: "tcm:1-2-2",
        purpose: "Component",
        rootElementName: "ArticleRoot",
        fields: {
            "Title": {
                "$type": "SingleLineTextFieldDefinition",
                "Name": "Title",
                "Description": "The title of the article."
            },
            "Abstract": {
                "$type": "MultiLineTextFieldDefinition",
                "Name": "Abstract",
                "Description": "The abstract of the article."
            },
            "Author": {
                "$type": "EmbeddedSchemaFieldDefinition",
                "Name": "Author",
                "Description": "An author of the article.",
                "EmbeddedSchema": {
                    "$type": "Link",
                    "IdRef": "tcm:1-123-8"
                },
                "EmbeddedFields": {}
            }
        }
    });

Example 5: Create a Schema with a multi-value checkbox field using a predefined list of dates.
    const result = await tools.createSchema({
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
    });

Example 6: Create a Schema with a multi-value Component Link field. This allows linking to multiple other Components. The 'MaxOccurs' property is set to -1 for unlimited values.
    const result = await tools.createSchema({
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
    });

Example 7: Create a Schema with a multi-value Multimedia Link field. This allows linking to multiple multimedia items like images or videos.
    const result = await tools.createSchema({
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
    });`,
    input: {
        title: z.string().nonempty().describe("The title for the new Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        purpose: z.enum([
            "Component", "Multimedia", "Embedded",
            "Metadata", "Bundle", "Region"
        ]).describe("The purpose of the Schema, which determines where it can be used."),
        rootElementName: xmlNameSchema.describe("The name of the root element for the XML structure defined by the Schema. When using two or more embeddable schemas in a schema (via embedded schema fields), this value needs to be unique between the embeddable schemas."),
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
    execute: async (args: any) => {
        const {
            title, locationId, purpose, rootElementName, description,
            fields, metadataFields, allowedMultimediaTypes, bundleProcessId,
            componentProcessId, deleteBundleOnProcessFinished, isIndexable,
            isPublishable, regionDefinition
        } = args;

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
            const processedFields = fields ? await processSchemaFieldDefinitions(fields, locationId) : undefined;
            const processedMetadataFields = metadataFields ? await processSchemaFieldDefinitions(metadataFields, locationId) : undefined;

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = purpose;
            payload.RootElementName = rootElementName;
            if (description) payload.Description = description;
            if (processedFields) payload.Fields = { "$type": "FieldsDefinitionDictionary", ...processedFields };
            if (processedMetadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
            if (allowedMultimediaTypes) payload.AllowedMultimediaTypes = toLinkArray(allowedMultimediaTypes);
            if (bundleProcessId) payload.BundleProcess = toLink(bundleProcessId);
            if (componentProcessId) payload.ComponentProcess = toLink(componentProcessId);
            if (typeof deleteBundleOnProcessFinished === 'boolean') payload.DeleteBundleOnProcessFinished = deleteBundleOnProcessFinished;
            if (typeof isIndexable === 'boolean') payload.IsIndexable = isIndexable;
            if (typeof isPublishable === 'boolean') payload.IsPublishable = isPublishable;
            if (regionDefinition) payload.RegionDefinition = regionDefinition;
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

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