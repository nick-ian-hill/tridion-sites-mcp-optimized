import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";
import { toLinkArray } from "../utils/links.js";

export const createSchema = {
    name: "createSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema'.
    Schemas define the structure of content and metadata for other CMS items.
    Content fields are defined in the fields property, and metadata fields in the metadataFields property.
    Fields and metadata fields are dictionaries that map field names to their corresponding field definition objects.

    The Name property for a field is an XML name and should not contain any space characters.
    The Description property of a field provides a human readable description of the field's purpose.
    
    The following field definitions are supported:
        SingleLineTextFieldDefinition
        MultiLineTextFieldDefinition
        KeywordFieldDefinition
        XhtmlFieldDefinition
        NumberFieldDefinition
        DateFieldDefinition
        ExternalLinkFieldDefinition
        ComponentLinkFieldDefinition
        MultimediaLinkFieldDefinition
        EmbeddedSchemaFieldDefinition

    For MultiLineTextFieldDefinition and XhtmlFieldDefinition fields, the Height property specifies the height of the field. This is only used in the User Interface.

    For lists, the following ListDefinition types are available:
        ListDefinition(for Keyword fields)
        SingleLineTextListDefinition
        NumberListDefinition
        DateListDefinition (for Date fields)

    For ListDefinition types, it's necessary to specify the 'Height' of the list and the list 'Type' (Tree, Select, Radio, Checkbox).

    The MaxOccurs and MinOccurs properties behave as described in XML Schema Definition 1.0 and can be used to make fields mandatory (e.g., MinOccurs: 1), multivalue (e.g., MaxOccurs: -1), etc.

    Allowed Multimedia Types are only applicable when the purpose of the Schema is 'Multimedia'.

    The IsIndexable property (true by default) means that the field value is included when performing a search.
    The IsLocalizable property (true by default) means that the field value can be modified in localized items.
    The IsPublishable property (true by default) means that the field value in included when publishing the item.`,
    input: {
        title: z.string().describe("The title for the new Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        purpose: z.enum([
            "Component", "Multimedia", "Embedded",
            "Metadata", "Bundle", "Region"
        ]).describe("The purpose of the Schema, which determines where it can be used."),
        rootElementName: z.string().describe("The name of the root element for the XML structure defined by the Schema."),
        description: z.string().optional().describe("An optional description for the Schema."),
        namespaceUri: z.string().optional().describe("The namespace URI (target namespace) of the Schema."),
        fields: z.record(z.any()).optional().describe("A dictionary of field definitions for the Schema's content. The keys of the dictionary are the machine names of the fields, and the values are the corresponding field definition objects."),
        metadataFields: z.record(z.any()).optional().describe("A dictionary of field definitions for the Schema's metadata. The keys of the dictionary are the machine names of the fields, and the values are the corresponding field definition objects."),
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
            title, locationId, purpose, rootElementName, description, namespaceUri,
            fields, metadataFields, allowedMultimediaTypes, bundleProcessId,
            componentProcessId, deleteBundleOnProcessFinished, isIndexable,
            isPublishable, regionDefinition
        } = args;

        // Validation for purpose-specific fields
        if (purpose !== 'Multimedia' && allowedMultimediaTypes) {
            return { content: [], errors: [{ message: "'allowedMultimediaTypes' can only be set when the Schema 'purpose' is 'Multimedia'." }] };
        }
        if (purpose !== 'Bundle' && typeof deleteBundleOnProcessFinished === 'boolean') {
            return { content: [], errors: [{ message: "'deleteBundleOnProcessFinished' can only be set when the Schema 'purpose' is 'Bundle'." }] };
        }
        if (purpose !== 'Region' && regionDefinition) {
            return { content: [], errors: [{ message: "'regionDefinition' can only be set when the Schema 'purpose' is 'Region'." }] };
        }

        try {
            // 1. Get the default model for the Schema type
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });

            if (defaultModelResponse.status !== 200) {
                return { content: [], errors: [{ message: `Failed to retrieve default model. Status: ${defaultModelResponse.status}, Message: ${defaultModelResponse.statusText}` }] };
            }

            const payload = defaultModelResponse.data;

            // 2. Customize the payload with provided arguments
            payload.Title = title;
            payload.Purpose = purpose;
            payload.RootElementName = rootElementName;

            if (description) payload.Description = description;
            if (namespaceUri) payload.NamespaceUri = namespaceUri;
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
                return {
                    content: [],
                    errors: [{ message: `Unexpected response status during Schema creation: ${createResponse.status}` }],
                };
            }

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to create Schema: ${errorMessage}` }],
            };
        }
    }
};