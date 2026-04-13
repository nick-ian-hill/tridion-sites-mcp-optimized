import { z, ZodIssue } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { processSchemaFieldDefinitions, formatForApi, invalidateSchemaCache } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

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
    const errorResponse = { type: 'Error', Message: message };
    return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }] };
};

export const updateSchemaFieldProperties = {
    name: "updateSchemaFieldProperties",
    summary: "Modifies properties of existing fields in a Schema (e.g., MinOccurs, Description, Pattern).",
    description: `Updates specific properties of one or more fields within a given Schema. For surgical updates, this is more efficient and robust than using the 'updateItemProperties' tool and replacing the entire fields collection.
    
BluePrint Note:
Field and Metadata Field definitions (the Schema structure) can ONLY be modified in the 'Primary' version of the Schema (where IsLocalized and IsShared are both false). 
- If a Schema is inherited (Shared), you must update the item in the parent publication.
- If a Schema is localized, you can update its Title/Description using 'updateItemProperties', but you CANNOT modify its fields here. You must update the Primary item from which it was localized.

Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in. If the item is already checked out by you, it will remain checked out after the update. The operation will be aborted if the item is checked out by another user.`,

    input: updateSchemaFieldPropertiesInputProperties,

    execute: async (
        params: z.infer<typeof updateSchemaFieldPropertiesSchema>,
        context: any
    ) => {
        formatForApi(params);
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

            // --- BluePrint Validation ---
            const bpInfo = itemToUpdate.BluePrintInfo;
            if (bpInfo) {
                const primaryId = bpInfo.PrimaryBluePrintParentItem?.IdRef;
                if (bpInfo.IsShared) {
                    return createJsonError(`Schema ${schemaId} is shared (inherited) and cannot be modified in this publication. You must update the primary item: ${primaryId || 'parent publication'}.`);
                }
                if (bpInfo.IsLocalized) {
                    return createJsonError(`Schema ${schemaId} is a localized copy. While localized items allow some property updates, the XML field structure can only be modified in the primary version of the Schema: ${primaryId || 'the original parent'}.`);
                }
            }

            for (const update of fieldUpdates) {
                const { fieldName, fieldLocation, propertyToUpdate, newValue } = update;
                const fieldCollection = fieldLocation === 'Content' ? itemToUpdate.Fields : itemToUpdate.MetadataFields;

                if (!fieldCollection) {
                    return createJsonError(`Schema ${schemaId} does not have a '${fieldLocation}' fields definition.`);
                }
                const fieldToUpdate = fieldCollection[fieldName];
                if (!fieldToUpdate) {
                    return createJsonError(`Field '${fieldName}' not found in the '${fieldLocation}' definition of Schema ${schemaId}.
                         Hint: This tool can only update properties of existing fields. To add, remove, or reorder fields, you must use the 'updateItemProperties' tool and provide the complete, new 'fields' or 'metadataFields' array.`);
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

            // --- Cache Invalidation ---
            // Clear the cache for this Schema so the next fetch gets the updated fields
            invalidateSchemaCache(schemaId);

            const updatedItem = updateResponse.data;

            const responseData = {
                type: updatedItem['$type'],
                Id: updatedItem.Id,
                Message: `Successfully updated ${updatedItem.Id}`
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            await diagnoseBluePrintError(error, params, schemaId, authenticatedAxios);

            if (error instanceof Error) {
                return createJsonError(error.message);
            }
            return handleAxiosError(error, `Failed to update fields for Schema ${schemaId}`);
        }
    },
    examples: [
        {
            description: "Make the 'articleBody' field optional and change the description of the 'headline' field in a single operation",
            payload: `const result = await tools.updateSchemaFieldProperties({
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
    });`
        },
        {
            description: "Make the metadata field 'AltText' mandatory",
            payload: `const result = await tools.updateSchemaFieldProperties({
        schemaId: "tcm:5-213-8",
        fieldUpdates: [
            {
                fieldName: "AltText",
                fieldLocation: "Metadata",
                propertyToUpdate: "MinOccurs",
                newValue: 1
            }
        ]
    });`
        },
        {
            description: "Update a validation constraint on a field",
            payload: `const result = await tools.updateSchemaFieldProperties({
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
                propertyToUpdate: "MaxValue",
                newValue: 10
            }
        ]
    });`
        }
    ]
};