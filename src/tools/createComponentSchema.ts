import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { xmlNameSchema } from "../schemas/xmlNameSchema.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

export const createComponentSchema = {
    name: "createComponentSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Component'.
Component Schemas define the structure for Components, which are the primary content items in the CMS.

A Component Schema can have both content fields (specified via the 'fields' property) and metadata fields (specified via the 'metadataFields' property).
The 'metadataFields' property is the ONLY way to define metafields for a Component (you cannot link a component to a standalone metadata schema).
Both of these properties are dictionaries where:
  - The KEY is the field's machine name (a valid XML name without spaces, e.g., "articleTitle").
  - The VALUE is a Field Definition object that specifies the field's type and properties.

When creating fields that link to other items (e.g., ComponentLinkFieldDefinition, EmbeddedSchemaFieldDefinition), you will need the TCM URIs of the allowed target schemas. Use the 'getSchemaLinks' tool to find suitable schemas within the target Publication.

Each Field Definition object MUST include a 'type' property to identify its type from the list below. Other common properties include:
  - Name: The machine name of the field (must match the key in the dictionary).
  - Description: A human-readable description of the field's purpose. This is mandatory.
  - MinOccurs: The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory).
  - MaxOccurs: The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value).
  - IsIndexable (Default: true): Whether the field value is included when performing a search.
  - IsLocalizable (Default: true): Whether the field value can be changed in localized items.
  - IsPublishable (Default: true): Whether the field value is included when publishing.

Supported Field Types ('type' values):
  - SingleLineTextFieldDefinition: A simple text input. XSD Schema properties like 'Pattern', 'MinLength', and 'MaxLength' can be used to restrict the allowed input values.
  - MultiLineTextFieldDefinition: A multi-line text area. Supports a 'Height' property for the UI.
  - XhtmlFieldDefinition: A rich-text (HTML) editor. Supports a 'Height' property for the UI. Can also include a 'FormattingFeatures' object to control the editor's toolbar.
  - KeywordFieldDefinition: - A link to a Keyword from a Category. This requires a 'Category' property with a Link object. This field type also requires a 'List' property (e.g., { "type": "ListDefinition", "Type": "Select" }) to define how the Keywords are displayed. The Category you link to must exist in the same Publication as the Schema or in a Parent Publication. You cannot link to a Category in a child or sibling Publication.
  - NumberFieldDefinition: A field for numeric values. The 'MinInclusive', 'MaxExclusive', 'TotalDigits', and 'FractionDigits' properties can be used to restrict the range of values.
  - DateFieldDefinition: A field for date/time values. The date range can be restricted using properties like 'MinInclusive', 'MaxExclusive', etc.
  - ExternalLinkFieldDefinition: A field for a URL.
  - ComponentLinkFieldDefinition: A link to another Component. Can use 'AllowedTargetSchemas' to restrict which types of Components can be linked.
  - MultimediaLinkFieldDefinition: A link to a multimedia item (e.g., image, video). Can use 'AllowedTargetSchemas' to restrict which types of multimedia can be linked.
  - EmbeddedSchemaFieldDefinition: Allows embedding fields from another Schema (which must have a purpose of 'Embedded'). Requires an 'EmbeddedSchema' property with a Link object (e.g., { "type": "Link", "IdRef": "tcm:1-123-8" }). Ensure a suitable embedded schema is available before trying to create a schema that links to one.

Some field types can be configured as lists to provide a selection of predefined values. This is done by adding a 'List' property to the field definition.
  - Supported List 'type' values: ListDefinition (for Keywords), SingleLineTextListDefinition, NumberListDefinition, DateListDefinition.
  - List Properties:
      - Type: The UI control for the list ('Select', 'Radio', 'Checkbox', 'Tree').
      - Height: The height of the list control in the UI.
      - Entries: An array of predefined values for the list.

BluePrint Context & 404 Errors:
Any IDs you provide for parameters or for field/metadata field values (e.g., in Component, Keyword, or Schema links) MUST exist in the same Publication as 'locationId'.
If any IDs reference items in a parent or other ancestor Publication, the items will be inherited by the context Publication, and the tool will map the IDs to the correct context automatically.
For example, if you are in 'locationId' "tcm:107-..." (Child) and reference a Keyword from "tcm:105-..." (Parent), the tool correctly maps this to the inherited ID "tcm:107-...".
As a result of the automatic mapping, you do not need to use the 'mapItemToContextPublication' tool for mapping purposes.

If you get a 404 'Not Found' error for an item you trying to reference (e.g., a Keyword) it likely means the item is in a sibling or child Publication, not a parent or other ancestor.
Items created in sibling/child Pubications are not inherited, and therefore the mapped ID will not correspond to a real item.

In this scenario, you will either need to
- find an alternative item that already exists in the context Publication,
- create a new item in the context Publication or a parent/ancestor, or
- promote the item(s) you are trying to reference to a parent or ancestor Publication using the 'promoteItem' tool.

To find the parent Publications, call getItem on your current Publication URI (e.g., 'tcm:0-99-1') and set includeProperties to ['Parents'].

Examples:

Example 1: Create a simple component Schema with a single, optional text field.
    const result = await tools.createComponentSchema({
        title: "Simple Text Schema",
        locationId: "tcm:1-2-2",
        rootElementName: "Content",
        description: "A simple schema with one text field.",
        fields: {
            "textField": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "textField",
                "Description": "A single line of text",
                "MaxOccurs": 1,
                "MinOccurs": 0
            }
        }
    });

Example 2: Create an 'Article' component Schema with both content fields and metadata fields.
    const result = await tools.createComponentSchema({
        title: "Article",
        locationId: "tcm:1-2-2",
        rootElementName: "Article",
        description: "Schema for news articles.",
        fields: {
            "title": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "title",
                "Description": "The main title of the article.",
                "MinOccurs": 1,
                "MaxOccurs": 1
            },
            "body": {
                "type": "XhtmlFieldDefinition",
                "Name": "body",
                "Description": "The main content of the article, which can include rich text formatting.",
                "Height": 10
            }
        },
        metadataFields: {
            "author": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "author",
                "Description": "The author of the article."
            },
            "publishDate": {
                "type": "DateFieldDefinition",
                "Name": "publishDate",
                "Description": "The date the article was published."
            }
        }
    });

Example 3: Create a Schema with an XHTML field that has custom formatting features, disabling several toolbar buttons.
    const result = await tools.createComponentSchema({
        title: "Rich Text Schema with Custom Formatting",
        locationId: "tcm:1-234-2",
        rootElementName: "RichText",
        description: "Schema for rich text with a limited toolbar.",
        fields: {
            "formattedContent": {
                "type": "XhtmlFieldDefinition",
                "Name": "formattedContent",
                "Description": "Rich text content with a restricted toolbar.",
                "Height": 15,
                "FormattingFeatures": {
                    "type": "FormattingFeatures",
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

Example 4: Create a Schema that uses an embeddable Schema for an embedded field. First, ensure you have an 'Embeddable' Schema created (e.g., an 'Author' Schema with TCM URI tcm:1-123-8). The embeddable Schema will be referenced via the 'EmbeddedSchema' property, the value of which should be a Link.
    const result = await tools.createComponentSchema({
        title: "ArticleSchema",
        locationId: "tcm:11-4567-2",
        rootElementName: "ArticleRoot",
        description: "Schema for an article with an embedded author.",
        fields: {
            "Title": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "Title",
                "Description": "The title of the article."
            },
            "Abstract": {
                "type": "MultiLineTextFieldDefinition",
                "Name": "Abstract",
                "Description": "The abstract of the article."
            },
            "Author": {
                "type": "EmbeddedSchemaFieldDefinition",
                "Name": "Author",
                "Description": "An author of the article.",
                "EmbeddedSchema": {
                    "type": "Link",
                    "IdRef": "tcm:11-123-8"
                }
            }
        }
    });

Example 5: Create a Schema with a multi-value Component Link field. This allows linking to multiple other Components. The 'MaxOccurs' property is set to -1 for unlimited values.
    const result = await tools.createComponentSchema({
        title: "Linked Articles",
        locationId: "tcm:18-2-2",
        rootElementName: "Links",
        description: "Schema for linking to related articles.",
        fields: {
            "relatedArticles": {
                "type": "ComponentLinkFieldDefinition",
                "Name": "relatedArticles",
                "Description": "Links to related articles.",
                "MaxOccurs": -1,
                "AllowedTargetSchemas": [
                    {
                        "type": "Link",
                        "IdRef": "tcm:18-103-8"
                    }
                ]
            }
        }
    });

Example 6: Create a Schema with a multi-value Multimedia Link field. This allows linking to multiple multimedia items like images or videos.
    const result = await tools.createComponentSchema({
        title: "Image Gallery",
        locationId: "tcm:1-2-2",
        rootElementName: "Gallery",
        description: "Schema for an image gallery.",
        fields: {
            "images": {
                "type": "MultimediaLinkFieldDefinition",
                "Name": "images",
                "Description": "Select multiple images for the gallery.",
                "MaxOccurs": -1,
                "AllowedTargetSchemas": [
                    {
                        "type": "Link",
                        "IdRef": "tcm:1-66-8"
                    }
                ]
            }
        }
    });

Example 7: Create a Schema with a Keyword field for classification. This field links to a Category, allowing editors to select from a predefined list of Keywords. Use 'getCategories' to find a suitable Category to link to.
    const result = await tools.createComponentSchema({
        title: "Article With Classification",
        locationId: "tcm:1-2-2",
        rootElementName: "Article",
        description: "Schema for an article with a keyword category.",
        fields: {
            "title": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "title",
                "Description": "The article title."
            },
            "category": {
                "type": "KeywordFieldDefinition",
                "Name": "category",
                "Description": "Classification for the article.",
                "MinOccurs": 0,
                "MaxOccurs": -1,
                "Category": {
                    "type": "Link",
                    "IdRef": "tcm:1-3-512"
                },
                "List": {
                    "type": "ListDefinition",
                    "Height": 5,
                    "Type": "Select"
                }
            }
        }
    });

Example 8: Create a Schema with advanced constraints.
    const result = await tools.createComponentSchema({
        title: "Data Schema With Constraints",
        locationId: "tcm:1-2-2",
        rootElementName: "RestrictedContent",
        description: "A Schema that uses various constraints for its fields.",
        fields: {
            "productCode": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "productCode",
                "Description": "Product code must be 2 uppercase letters followed by 4 numbers.",
                "MinOccurs": 1,
                "Pattern": "[A-Z]{2}[0-9]{4}"
            },
            "rating": {
                "type": "NumberFieldDefinition",
                "Name": "rating",
                "Description": "Rating must be a number between 1 and 5 (inclusive).",
                "MinOccurs": 1,
                "MinInclusive": 1,
                "MaxInclusive": 5
            },
            "price": {
                "type": "NumberFieldDefinition",
                "Name": "price",
                "Description": "Price with a maximum of 5 total digits and 2 decimal places.",
                "TotalDigits": 5,
                "FractionDigits": 2
            }
        }
    });
    `,
    input: {
        title: z.string().nonempty().describe("The title for the new Component Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created. Use 'search' or 'getItemsInContainer' to find a Folder."),
        rootElementName: xmlNameSchema.describe("The name of the root element for the XML structure defined by the Schema (e.g., 'Article', 'Content')."),
        description: z.string().nonempty().describe("An mandatory description of the Schema."),
        fields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of field definitions for the schema's content fields. The keys of the dictionary are the machine names of the fields."),
        metadataFields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of metadata field definitions for the schema's metadata. The keys of the dictionary are the machine names of the metadata fields. This is the ONLY way to define metadata for a Component."),
        componentProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of a Process Definition to associate as the Component Process for workflow."),
        isIndexable: z.boolean().optional().describe("Specifies whether Components based on this Schema will be indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether Components based on this Schema can be resolved for data publishing."),
    },
    execute: async (args: any, context: any) => {
        formatForApi(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, rootElementName, description,
            fields, metadataFields, componentProcessId, isIndexable,
            isPublishable
        } = args;

        const authenticatedAxios = createAuthenticatedAxios(userSessionId);
        
        try {
            const processedFields = fields ? await processSchemaFieldDefinitions(fields, locationId, authenticatedAxios) : undefined;
            const processedMetadataFields = metadataFields ? await processSchemaFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = "Component";
            payload.RootElementName = rootElementName;

            if (description) payload.Description = description;
            if (processedFields) payload.Fields = { "$type": "FieldsDefinitionDictionary", ...processedFields };
            if (processedMetadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
            if (componentProcessId) payload.ComponentProcess = toLink(componentProcessId);
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
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            await diagnoseBluePrintError(error, args, locationId, authenticatedAxios);
            return handleAxiosError(error, "Failed to create Component Schema");
        }
    }
};