import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink, toLinkArray } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processSchemaFieldDefinitions } from "../utils/fieldReordering.js";

export const createMultimediaSchema = {
    name: "createMultimediaSchema",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Multimedia'.
    
Multimedia Schemas define the metadata fields for Multimedia Components (e.g., images, videos, PDFs).
They also specify which file types are allowed using the 'allowedMultimediaTypes' property.

The schema's structure is defined using the 'metadataFields' property.

Examples:

Example 1: Create a simple Multimedia Schema for images.
    const result = await tools.createMultimediaSchema({
        title: "Image Schema",
        locationId: "tcm:1-2-2",
        description: "A schema for image metadata.",
        allowedMultimediaTypes: [
            "tcm:0-2-65544", // JPEG
            "tcm:0-3-65544"  // PNG
        ],
        metadataFields: {
            "altText": {
                "$type": "SingleLineTextFieldDefinition",
                "Name": "altText",
                "Description": "Alternative text for accessibility.",
                "MinOccurs": 1
            },
            "caption": {
                "$type": "SingleLineTextFieldDefinition",
                "Name": "caption",
                "Description": "A caption for the image.",
                "MinOccurs": 0
            }
        }
    });
    `,
    input: {
        title: z.string().nonempty().describe("The title for the new Multimedia Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        metadataFields: z.record(fieldDefinitionSchema).optional().describe("A dictionary of metadata field definitions for the schema."),
        allowedMultimediaTypes: z.array(z.string().regex(/^tcm:0-\d+-65544$/)).optional().describe("An array of TCM URIs for allowed Multimedia Types. Use 'getMultimediaTypes' to find available types."),
        isIndexable: z.boolean().optional().describe("Specifies whether metadata values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether metadata values are published.")
    },
    execute: async (args: any, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, description, metadataFields,
            allowedMultimediaTypes, isIndexable, isPublishable
        } = args;
        
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const processedMetadataFields = metadataFields ? await processSchemaFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = "Multimedia";
            delete payload.RootElementName;

            if (description) payload.Description = description;
            if (processedMetadataFields) payload.MetadataFields = { "$type": "FieldsDefinitionDictionary", ...processedMetadataFields };
            if (allowedMultimediaTypes) payload.AllowedMultimediaTypes = toLinkArray(allowedMultimediaTypes);
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
            return handleAxiosError(error, "Failed to create Multimedia Schema");
        }
    }
};