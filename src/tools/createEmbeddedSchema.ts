import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { xmlNameSchema } from "../schemas/xmlNameSchema.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processAndOrderFieldDefinitions, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";
import { getCachedDefaultModel } from "../utils/defaultModelCache.js";

export const createEmbeddedSchema = {
    name: "createEmbeddedSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Embedded'.

BluePrint Inheritance Note:
The Schema will be created in the specified Folder and be automatically inherited by all descendant Publications.

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
        fields: [
            {
                "type": "SingleLineTextFieldDefinition",
                "Name": "name",
                "Description": "The author's full name.",
                "MinOccurs": 1,
                "MaxOccurs": 1
            },
            {
                "type": "MultiLineTextFieldDefinition",
                "Name": "biography",
                "Description": "A short biography of the author.",
                "Height": 5,
                "MinOccurs": 0
            }
        ]
    });
    `,
    input: {
        title: z.string().nonempty().describe("The title for the new Embedded Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        rootElementName: xmlNameSchema.describe("The name of the root element for the XML structure. This is mandatory for Embedded Schemas."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        fields: z.array(fieldDefinitionSchema).optional().describe("An array of field definitions for the schema's content fields. The order of the array determines the field order."),
        isIndexable: z.boolean().optional().describe("Specifies whether field values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether field values are published.")
    },
    execute: async (args: any, context: any) => {
        formatForApi(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, rootElementName, description,
            fields, isIndexable, isPublishable
        } = args;

        const authenticatedAxios = createAuthenticatedAxios(userSessionId);
        
        try {
            const processedFields = fields ? await processAndOrderFieldDefinitions(fields, locationId, authenticatedAxios) : undefined;

            let payload;
            try {
                payload = await getCachedDefaultModel("Schema", locationId, authenticatedAxios);
            } catch (error: any) {
                return handleAxiosError(error, "Failed to load default model for Schema");
            }
            payload.Title = title;
            payload.Purpose = "Embedded";
            payload.RootElementName = rootElementName;

            if (description) payload.Description = description;
            if (processedFields) payload.Fields = processedFields;
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
            return handleAxiosError(error, "Failed to create Embedded Schema");
        }
    }
};