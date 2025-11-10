import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { xmlNameSchema } from "../schemas/xmlNameSchema.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions } from "../utils/fieldReordering.js";

export const createSchema = {
    name: "createSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' for purposes other than 'Component'.
    To create a Component Schema, please use the dedicated 'createComponentSchema' tool.
    
Schemas define the structure of content and metadata for other CMS items.
Schemas with a purpose of 'Embedded' define their structure using the 'fields' property.
Schemas with any other purpose (e.g., 'Metadata', 'Region', 'Bundle') define their structure using the 'metadataFields' property.
Both of these properties are dictionaries where:
  - The KEY is the field's machine name (a valid XML name without spaces, e.g., "articleTitle").
  - The VALUE is a Field Definition object that specifies the field's type and properties.

When creating fields that link to other items (e.g., EmbeddedSchemaFieldDefinition), you will need the TCM URIs of the allowed target schemas. Use the 'getSchemaLinks' tool to find suitable schemas within the target Publication.

Each Field Definition object MUST include a '$type' property to identify its type from the list below. Other common properties include:
  - Name: The machine name of the field (must match the key in the dictionary).
  - Description: A human-readable description of the field's purpose. This is mandatory.
  - MinOccurs: The minimum number of times the field can occur (e.g., 0 for optional, 1 for mandatory).
  - MaxOccurs: The maximum number of times the field can occur (e.g., 1 for single-value, -1 for unlimited multi-value).
  - IsIndexable (Default: true): Whether the field value is included when performing a search.
  - IsLocalizable (Default: true): Whether the field value can be changed in localized items.
  - IsPublishable (Default: true): Whether the field value is included when publishing.

Supported Field Types ('$type' values):
  - SingleLineTextFieldDefinition: A simple text input. XSD Schema properties like 'Pattern', 'MinLength', and 'MaxLength' can be used to restrict the allowed input values.
  - MultiLineTextFieldDefinition: A multi-line text area. Supports a 'Height' property for the UI.
  - XhtmlFieldDefinition: A rich-text (HTML) editor. Supports a 'Height' property for the UI. Can also include a 'FormattingFeatures' object to control the editor's toolbar.
  - KeywordFieldDefinition: - A link to a Keyword from a Category. This requires a 'Category' property with a Link object. The Category you link to must exist in the same Publication as the Schema or in a Parent Publication. You cannot link to a Category in a child or sibling Publication.
  - NumberFieldDefinition: A field for numeric values. The 'MinInclusive', 'MaxExclusive', 'TotalDigits', and 'FractionDigits' properties can be used to restrict the range of values.
  - DateFieldDefinition: A field for date/time values. The date range can be restricted using properties like 'MinInclusive', 'MaxExclusive', etc.
  - ExternalLinkFieldDefinition: A field for a URL.
  - ComponentLinkFieldDefinition: A link to another Component. Can use 'AllowedTargetSchemas' to restrict which types of Components can be linked.
  - MultimediaLinkFieldDefinition: A link to a multimedia item (e.g., image, video). Can use 'AllowedTargetSchemas' to restrict which types of multimedia can be linked.
  - EmbeddedSchemaFieldDefinition: Allows embedding fields from another Schema (which must have a purpose of 'Embedded'). Requires an 'EmbeddedSchema' property with a Link object (e.g., { "$type": "Link", "IdRef": "tcm:1-123-8" }). Ensure a suitable embedded schema is available before trying to create a schema that links to one.

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

BluePrint Context & 404 Errors:
Any IDs you provide for parameters or fields (e.g., in a KeywordFieldDefinition or ComponentLinkDefinition) MUST exist in the same Publication as 'locationId'.
If any IDs reference items in a parent or other ancestor Publication, the items will be inherited by the context Publication, and the tool will map the IDs to the correct context automatically.
For example, if you are in 'locationId' "tcm:107-..." (Child) and use a Category 'IdRef' "tcm:105-..." (Parent), the tool correctly maps this to the inherited ID "tcm:107-...".
As a result of the automatic mapping, you do not need to use the 'mapItemToContextPublication' tool for mapping purposes.

If you get a 404 'Not Found' error for an item you trying to reference (e.g., a Category) it likely means the item is in a sibling or child Publication, not a parent or other ancestor.
Items created in sibling/child Pubications are not inherited, and therefore the mapped ID will not correspond to a real item.

In this scenario, you will either need to
- find an alternative item that already exists in the context Publication,
- create a new item in the context Publication or a parent/ancestor, or
- promote the item(s) you are trying to reference to a parent or ancestor Publication using the 'promoteItem' tool.

To find the parent Publications, call getItem on your current Publication URI (e.g., 'tcm:0-99-1') and set includeProperties to ['Parents'].

Examples:

Example 1: Create a simple Metadata Schema. Note the 'purpose' is 'Metadata', there is no 'rootElementName', and the fields are defined in 'metadataFields'.
    const result = await tools.createSchema({
        title: "Simple Metadata Schema",
        locationId: "tcm:1-2-2",
        purpose: "Metadata",
        description: "A simple schema for metadata.",
        metadataFields: {
            "textField": {
                "$type": "SingleLineTextFieldDefinition",
                "Name": "textField",
                "Description": "A single line of text",
                "MaxOccurs": 1,
                "MinOccurs": 0
            }
        }
    });

Example 2: Create a Metadata Schema with a multi-value checkbox field using a predefined list of dates.
    const result = await tools.createSchema({
        title: "Date Selection",
        locationId: "tcm:1-2-2",
        purpose: "Metadata",
        description: "A metadata schema for selecting dates.",
        metadataFields: {
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

Example 3: Create a Region Schema with constraints on its Component Presentations. This region will allow up to 5 CPs that must use a specific Schema and Component Template.
    const result = await tools.createSchema({
        title: "Constrained Region Schema",
        locationId: "tcm:5-2-2",
        purpose: "Region",
        description: "A Region that constrains what can be put inside it.",
        regionDefinition: JSON.stringify({
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
        })
    });
    
Example 4: Create an 'Embedded' Schema to be used within other Schemas.
    const result = await tools.createSchema({
        title: "Author Details",
        locationId: "tcm:20-1234-2",
        purpose: "Embedded",
        rootElementName: "AuthorDetails",
        description: "An embeddable schema for author information, containing their name and biography. This schema can then be inserted into other schemas using an 'EmbeddedSchemaFieldDefinition'.",
        fields: {
            "name": {
                "$type": "SingleLineTextFieldDefinition",
                "Name": "name",
                "Description": "The author's full name.",
                "MinOccurs": 1,
                "MaxOccurs": 1
            },
            "biography": {
                "$type": "MultiLineTextFieldDefinition",
                "Name": "biography",
                "Description": "A short biography of the author.",
                "Height": 5,
                "MinOccurs": 0
            }
        }
    });
    `,
    input: {
        title: z.string().nonempty().describe("The title for the new Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created. Use 'search' or 'getItemsInContainer' to find a Folder."),
        purpose: z.enum([
            "Multimedia", "Embedded",
            "Metadata", "Bundle", "Region"
        ]).describe(`The purpose of the Schema, which determines the item type(s) for which it can be used.
            To create a Component Schema, use the dedicated 'createComponentSchema' tool.
            When asked to create a metadata schema, be sure to set the purpose to 'Metadata' and use the 'metadataFields' property for defining the fields.`),
        rootElementName: xmlNameSchema.optional().describe("The name of the root element for the XML structure defined by the Schema. Only applies to 'Embedded' schemas. When using two or more embeddable schemas in a schema (via embedded schema fields), this value needs to be unique between the embeddable schemas."),
        description: z.string().nonempty().describe("An mandatory description of the Schema."),
        fields: z.record(fieldDefinitionSchema).optional().describe("Only used for 'Embedded' Schemas. A dictionary of field definitions for the schema's content fields. The keys of the dictionary are the machine names of the fields."),
        metadataFields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of metadata field definitions for the schema's metadata. The keys of the dictionary are the machine names of the metadata fields. You MUST use this property when defining fields for 'Metadata', 'Bundle', 'Multimedia', and 'Region' schemas."),
        allowedMultimediaTypes: z.array(z.string().regex(/^tcm:0-\d+-65544$/)).optional().describe("An array of TCM URIs for allowed Multimedia Types. Only applicable when 'purpose' is 'Multimedia'."),
        bundleProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of a Process Definition to associate as the Bundle Process."),
        deleteBundleOnProcessFinished: z.boolean().optional().describe("If true, Bundles based on this Schema will be deleted when their workflow process finishes. Only applicable when 'purpose' is 'Bundle'."),
        isIndexable: z.boolean().optional().describe("Specifies whether Components based on this Schema will be indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether Components based on this Schema can be resolved for data publishing."),
        regionDefinition: z.string().optional().describe("A JSON string for the Region Definition. Only applicable when 'purpose' is 'Region'. This object can contain 'ComponentPresentationConstraints', which is an array of 'OccurrenceConstraint' and 'TypeConstraint' objects. 'OccurrenceConstraint' uses 'MinOccurs' and 'MaxOccurs' to limit the number of CPs. 'TypeConstraint' uses 'BasedOnSchema' and/or 'BasedOnComponentTemplate' (Link objects) to restrict the type of CPs allowed.")
    },
    execute: async (args: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, purpose, rootElementName, description,
            fields, metadataFields, allowedMultimediaTypes, bundleProcessId,
            componentProcessId, deleteBundleOnProcessFinished, isIndexable,
            isPublishable, regionDefinition
        } = args;
        
        const createErrorResponse = (message: string) => {
            const errorResponse = { $type: 'Error', Message: message };
            return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }], errors: [] };
        };

        if (purpose === 'Embedded' && (!rootElementName || rootElementName.trim() === '')) {
            return createErrorResponse("Validation Error: The 'rootElementName' property is mandatory when the Schema 'purpose' is 'Embedded'.");
        }
        if (purpose !== 'Multimedia' && allowedMultimediaTypes) {
            return createErrorResponse("'allowedMultimediaTypes' can only be set when the Schema 'purpose' is 'Multimedia'.");
        }
        if (purpose !== 'Bundle' && typeof deleteBundleOnProcessFinished === 'boolean') {
            return createErrorResponse("'deleteBundleOnProcessFinished' can only be set when the Schema 'purpose' is 'Bundle'.");
        }
        if (purpose !== 'Region' && regionDefinition) {
            return createErrorResponse("'regionDefinition' can only be set when the Schema 'purpose' is 'Region'.");
        }
        if (purpose !== 'Embedded' && fields) {
            return createErrorResponse("The 'fields' property can only be used when the Schema 'purpose' is 'Embedded'. For other types, use 'metadataFields'.");
        }

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const processedFields = fields ? await processSchemaFieldDefinitions(fields, locationId, authenticatedAxios) : undefined;
            const processedMetadataFields = metadataFields ? await processSchemaFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            let parsedRegionDefinition;
            if (regionDefinition) {
                if (purpose !== 'Region') {
                    return createErrorResponse("'regionDefinition' can only be set when the Schema 'purpose' is 'Region'.");
                }
                try {
                    parsedRegionDefinition = JSON.parse(regionDefinition);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return createErrorResponse(`Error: The 'regionDefinition' parameter is not a valid JSON string. Details: ${errorMessage}`);
                }
            }

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = purpose;

            if (purpose === 'Embedded') {
                payload.RootElementName = rootElementName;
            } else {
                delete payload.RootElementName;
            }

            if (description) payload.Description = description;
            if (processedFields) payload.Fields = { "$type": "FieldsDefinitionDictionary", ...processedFields };
            if (processedMetadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
            if (allowedMultimediaTypes) payload.AllowedMultimediaTypes = toLinkArray(allowedMultimediaTypes);
            if (bundleProcessId) payload.BundleProcess = toLink(bundleProcessId);
            if (componentProcessId) payload.ComponentProcess = toLink(componentProcessId);
            if (typeof deleteBundleOnProcessFinished === 'boolean') payload.DeleteBundleOnProcessFinished = deleteBundleOnProcessFinished;
            if (typeof isIndexable === 'boolean') payload.IsIndexable = isIndexable;
            if (typeof isPublishable === 'boolean') payload.IsPublishable = isPublishable;
            if (parsedRegionDefinition) payload.RegionDefinition = parsedRegionDefinition;
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
            return handleAxiosError(error, "Failed to create Schema");
        }
    }
};