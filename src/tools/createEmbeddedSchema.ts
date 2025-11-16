import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { xmlNameSchema } from "../schemas/xmlNameSchema.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions } from "../utils/fieldReordering.js";

export const createEmbeddedSchema = {
    name: "createEmbeddedSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Embedded'.
    
Embedded Schemas are reusable groups of fields that can be inserted into other Schemas (both Component and Metadata) using an 'EmbeddedSchemaFieldDefinition'.
The 'rootElementName' is mandatory and must be a valid XML name.
The structure of an Embedded Schema is defined using the 'fields' property.

Examples:

Example 1: Create an 'Author Details' Embedded Schema.
This schema can then be used inside other schemas (like an 'Article' schema) to add author information.
    const result = await tools.createEmbeddedSchema({
        title: "Author Details",
        locationId: "tcm:20-1234-2",
        rootElementName: "AuthorDetails",
        description: "An embeddable schema for author information.",
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
        title: z.string().nonempty().describe("The title for the new Embedded Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        rootElementName: xmlNameSchema.describe("The name of the root element for the XML structure. This is mandatory for Embedded Schemas."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        fields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of field definitions for the schema's content fields."),
        isIndexable: z.boolean().optional().describe("Specifies whether field values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether field values are published.")
    },
    execute: async (args: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, rootElementName, description,
            fields, isIndexable, isPublishable
        } = args;
        
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const processedFields = fields ? await processSchemaFieldDefinitions(fields, locationId, authenticatedAxios) : undefined;

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = "Embedded";
            payload.RootElementName = rootElementName;

            if (description) payload.Description = description;
            if (processedFields) payload.Fields = { "$type": "FieldsDefinitionDictionary", ...processedFields };
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
            return handleAxiosError(error, "Failed to create Embedded Schema");
        }
    }
};