import { z, ZodIssue } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { processSchemaFieldDefinitions, sanitizeAgentJson } from "../utils/fieldReordering.js";

import {
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
} from "../schemas/fieldValueSchema.js";

const fieldUpdateSchema = z.object({
    fieldName: z.string().describe("The XML name of the field to modify (e.g., 'articleBody')."),
    fieldLocation: z.enum(["Content", "Metadata"]).describe("Specifies whether the field is in the 'Content' or 'Metadata' definition."),
    propertyToUpdate: z.string().describe("The name of the property to change, using dot notation for nested properties (e.g., 'MinOccurs', 'List.Type')."),

    newValue: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.record(z.any()),
        z.array(z.record(z.any()))
    ]).describe("The new value for the property. Can be a string, number, boolean, or a JSON object for complex properties like 'AllowedTargetSchemas'.")
});

const updateSchemaFieldPropertiesInputProperties = {
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The unique ID (TCM URI) of the Schema to update."),
    fieldUpdates: z.array(fieldUpdateSchema).min(1).describe("An array of update operations to perform on the Schema's fields.")
};

const updateSchemaFieldPropertiesSchema = z.object(updateSchemaFieldPropertiesInputProperties);

// Map field types to their corresponding Zod schemas for easy lookup.
const schemaTypeMap = {
    "SingleLineTextFieldDefinition": singleLineTextFieldSchema,
    "MultiLineTextFieldDefinition": multiLineTextFieldSchema,
    "XhtmlFieldDefinition": xhtmlFieldSchema,
    "KeywordFieldDefinition": keywordFieldSchema,
    "NumberFieldDefinition": numberFieldSchema,
    "DateFieldDefinition": dateFieldSchema,
    "ExternalLinkFieldDefinition": externalLinkFieldSchema,
    "ComponentLinkFieldDefinition": componentLinkFieldSchema,
    "MultimediaLinkFieldDefinition": multimediaLinkFieldSchema,
    "EmbeddedSchemaFieldDefinition": embeddedSchemaFieldSchema
};

/**
 * Sets a potentially nested property on an object using a dot-notation path.
 * @param obj The object to modify.
 * @param path The dot-notation path for the property.
 * @param value The value to set.
 */
const setNestedProperty = (obj: any, path: string, value: any): void => {
    const keys = path.split('.');
    let current = obj;
    while (keys.length > 1) {
        const key = keys.shift()!;
        if (current[key] === undefined || typeof current[key] !== 'object' || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[keys[0]] = value;
};

// Helper to create a JSON error response
const createJsonError = (message: string) => {
    const errorResponse = { $type: 'Error', Message: message };
    return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }] };
};

export const updateSchemaFieldProperties = {
    name: "updateSchemaFieldProperties",
    description: `Updates specific properties of one or more fields within a given Schema. For surgical updates, this is more efficient and robust than using the 'updateItemProperties' tool and replacing the entire fields collection.
    
Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in. If the item is already checked out by you, it will remain checked out after the update. The operation will be aborted if the item is checked out by another user.

Example 1: Make the 'articleBody' field optional and change the description of the 'headline' field in a single operation.
    const result = await tools.updateSchemaFieldProperties({
        schemaId: "tcm:2-104-8",
        fieldUpdates: [
            {
                fieldName: "articleBody",
                fieldLocation: "Content",
                propertyToUpdate: "MinOccurs",
                newValue: 0
            },
            {
                fieldName: "headline",
                fieldLocation: "Content",
                propertyToUpdate: "Description",
                newValue: "The main headline for the news article."
            }
        ]
    });
    
Example 2: Make the metadata field 'AltText' mandatory.
    const result = await tools.updateSchemaFieldProperties({
        schemaId: "tcm:5-213-8",
        fieldUpdates: [
            {
                fieldName: "AltText",
                fieldLocation: "Metadata",
                propertyToUpdate: "MinOccurs",
                newValue: 1
            }
        ]
    });

Example 3: Update a validation constraint on a field.
    const result = await tools.updateSchemaFieldProperties({
        schemaId: "tcm:1-250-8",
        fieldUpdates: [
            {
                fieldName: "productCode",
                fieldLocation: "Content",
                propertyToUpdate: "Pattern",
                newValue: "[A-Z]{3}[0-9]{5}"
            },
            {
                fieldName: "rating",
                fieldLocation: "Content",
                propertyToUpdate: "MaxInclusive",
                newValue: 10
            }
        ]
    });
    `,

    input: updateSchemaFieldPropertiesInputProperties,
    
    execute: async (
        params: z.infer<typeof updateSchemaFieldPropertiesSchema>, 
        context: any
    ) => {
        sanitizeAgentJson(params);
        const { schemaId, fieldUpdates } = params;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const restItemId = schemaId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            const itemToUpdate = getItemResponse.data;

            for (const update of fieldUpdates) {
                const { fieldName, fieldLocation, propertyToUpdate, newValue } = update;
                const fieldCollection = fieldLocation === 'Content' ? itemToUpdate.Fields : itemToUpdate.MetadataFields;

                if (!fieldCollection) {
                    return createJsonError(`Schema ${schemaId} does not have a '${fieldLocation}' fields definition.`);
                }
                const fieldToUpdate = fieldCollection[fieldName];
                if (!fieldToUpdate) {
                     return createJsonError(`Field '${fieldName}' not found in the '${fieldLocation}' definition of Schema ${schemaId}.
                         Hint: This tool can only update properties of existing fields. To add a new field, you must use the 'updateItemProperties' tool and provide the complete, new 'fields' or 'metadataFields' collection.`);
                }

                const fieldType = fieldToUpdate.$type as keyof typeof schemaTypeMap;
                const zodSchemaForField = schemaTypeMap[fieldType];

                if (!zodSchemaForField) {
                     return createJsonError(`Validation failed: Unknown field type '${fieldType}' for field '${fieldName}'.`);
                }

                // 1. Validate the path
                const pathParts = propertyToUpdate.split('.');
                let currentValidator: any = zodSchemaForField;
                try {
                    for (const part of pathParts) {
                        if (currentValidator.shape && part in currentValidator.shape) {
                            currentValidator = currentValidator.shape[part];
                        } else {
                            throw new Error(); // Path part not found in schema shape
                        }
                    }
                } catch {
                     return createJsonError(`Validation failed: Property path '${propertyToUpdate}' is not valid for a field of type '${fieldType}'.`);
                }

                // 2. Validate the value against the final validator in the path
                const validationResult = currentValidator.safeParse(newValue);
                if (!validationResult.success) {
                    const errorMessages = validationResult.error.errors.map((e: ZodIssue) => e.message).join(', ');
                    return createJsonError(`Validation failed for '${propertyToUpdate}': ${errorMessages}`);
                }
                
                // If validation passes, perform the update
                setNestedProperty(fieldToUpdate, propertyToUpdate, newValue);
            }

            const schemaLocationId = itemToUpdate.LocationInfo?.OrganizationalItem?.IdRef;
            if (!schemaLocationId) {
                return createJsonError(`Could not determine location for Schema ${schemaId} to process field updates.`);
            }

            // Reprocess/Reorder fields after modification
            if (itemToUpdate.Fields) {
                itemToUpdate.Fields = await processSchemaFieldDefinitions(itemToUpdate.Fields, schemaLocationId, authenticatedAxios);
            }
            if (itemToUpdate.MetadataFields) {
                itemToUpdate.MetadataFields = await processSchemaFieldDefinitions(itemToUpdate.MetadataFields, schemaLocationId, authenticatedAxios);
            }

            // Save the updated Schema
            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) return handleUnexpectedResponse(updateResponse);
            const updatedItem = updateResponse.data;

            const responseData = {
                $type: updatedItem['$type'],
                Id: updatedItem.Id,
                Message: `Successfully updated ${updatedItem.Id}`
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
             if (error instanceof Error) {
                return createJsonError(error.message);
            }
            return handleAxiosError(error, `Failed to update fields for Schema ${schemaId}`);
        }
    }
};