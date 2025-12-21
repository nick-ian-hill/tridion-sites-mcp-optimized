import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";
import { getCachedDefaultModel } from "../utils/defaultModelCache.js";

export const createMetadataSchema = {
    name: "createMetadataSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Metadata'.
    
Metadata Schemas define the structure for metadata fields that can be applied to items like Folders, Structure Groups, Pages, Keywords, etc.
(Note: To add metadata to a Component, you must define 'metadataFields' on the Component Schema using 'createComponentSchema'.)

The schema's structure is defined using the 'metadataFields' property, which is a dictionary of field definitions.

BluePrint Inheritance Note:
The Schema will be created in the specified Folder and be automatically inherited by all descendant Publications.

Examples:

Example 1: Create a simple Metadata Schema for Folders.
    const result = await tools.createMetadataSchema({
        title: "Folder Metadata",
        locationId: "tcm:1-2-2",
        description: "A simple schema for folder metadata.",
        metadataFields: {
            "owner": {
                "type": "SingleLineTextFieldDefinition",
                "Name": "owner",
                "Description": "The owner of the folder.",
                "MaxOccurs": 1,
                "MinOccurs": 1
            }
        }
    });

Example 2: Create a Metadata Schema with a multi-value checkbox field using a predefined list of dates.
    const result = await tools.createMetadataSchema({
        title: "Date Selection",
        locationId: "tcm:1-2-2",
        description: "A metadata schema for selecting dates.",
        metadataFields: {
            "availableDates": {
                "type": "DateFieldDefinition",
                "Name": "availableDates",
                "Description": "Select your preferred dates.",
                "MaxOccurs": -1,
                "List": {
                    "type": "DateListDefinition",
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
    `,
    input: {
        title: z.string().nonempty().describe("The title for the new Metadata Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        metadataFields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of metadata field definitions for the schema."),
        isIndexable: z.boolean().optional().describe("Specifies whether metadata values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether metadata values are published.")
    },
    execute: async (args: any, context: any) => {
        formatForApi(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, description, metadataFields,
            isIndexable, isPublishable
        } = args;

        const authenticatedAxios = createAuthenticatedAxios(userSessionId);
        
        try {
            const processedMetadataFields = metadataFields ? await processSchemaFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            let payload;
            try {
                payload = await getCachedDefaultModel("Schema", locationId, authenticatedAxios);
            } catch (error: any) {
                return handleAxiosError(error, "Failed to load default model for Schema");
            }
            
            payload.Title = title;
            payload.Purpose = "Metadata";
            delete payload.RootElementName;

            if (description) payload.Description = description;
            if (processedMetadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
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
            return handleAxiosError(error, "Failed to create Metadata Schema");
        }
    }
};