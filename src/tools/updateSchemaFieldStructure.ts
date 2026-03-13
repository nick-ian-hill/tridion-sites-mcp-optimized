import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { processSchemaFieldDefinitions, formatForApi, invalidateSchemaCache } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";

const operationSchema = z.object({
    action: z.enum(["add", "remove", "move"]).describe("The structural operation to perform."),
    fieldLocation: z.enum(["Content", "Metadata"]).describe("Specifies whether to modify the 'Content' or 'Metadata' fields."),
    fieldName: z.string().optional().describe("The machine name of the field to remove or move. Optional for 'add' (inferred from fieldDefinition)."),
    fieldDefinition: fieldDefinitionSchema.optional().describe("The full field definition object. Required only for 'add' operations."),
    insertAfter: z.string().nullable().optional().describe("The machine name of the field after which the added/moved field should be placed. Use the special value '[TOP]' to place the field at the very beginning. If null or omitted, the field is placed at the end of the array.")
}).refine(data => {
    if (data.action === "add" && !data.fieldDefinition) return false;
    if ((data.action === "remove" || data.action === "move") && !data.fieldName) return false;
    return true;
}, { message: "Validation Error: 'add' operations require a 'fieldDefinition'. 'remove' and 'move' operations require a 'fieldName'." });

const updateSchemaFieldStructureInputProperties = {
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The unique ID (TCM URI) of the Schema to update."),
    operations: z.array(operationSchema).min(1).describe("An array of structural operations (add, remove, move) to perform on the Schema's fields. Operations are executed sequentially."),
    applyToPrimary: z.boolean().optional().describe("If true, automatically resolves and applies the updates to the Primary (original parent) Schema if the provided 'schemaId' belongs to a Shared or Localized item.")
};

const updateSchemaFieldStructureSchema = z.object(updateSchemaFieldStructureInputProperties);

// Helper to create a JSON error response
const createJsonError = (message: string) => {
    const errorResponse = { type: 'Error', Message: message };
    return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }] };
};

export const updateSchemaFieldStructure = {
    name: "updateSchemaFieldStructure",
    description: `Surgically updates the structural definition of a Schema's fields by adding, removing, or moving fields.
    This tool is highly efficient as it targets specific field positions without requiring you to replace the entire field array.

Scope:
- This tool is EXCLUSIVELY for modifying 'Content' or 'Metadata' fields like Text, Number, ComponentLink.
- DO NOT use this tool to modify Region definitions (i.e., do not pass 'NestedRegion' or 'RegionDefinition' objects). To add or modify regions in a Region Schema, use the 'updateItemProperties' tool and pass the full 'regionDefinition' object.

BluePrint Note:
Field and Metadata Field definitions can ONLY be modified in the 'Primary' version of the Schema (where IsLocalized and IsShared are false).
- If you attempt to update a Shared or Localized schema, the update will be blocked.
- You can pass \`applyToPrimary: true\` to have the tool automatically find and update the Primary schema item instead.

Operations:
- 'add': Inserts a new field. Requires 'fieldDefinition'.
- 'remove': Deletes a field. Requires 'fieldName'.
- 'move': Repositions an existing field. Requires 'fieldName'.
- 'insertAfter': Optional for 'add' and 'move'. Specifies the machine name of the field to place the targeted field after. Use '[TOP]' to place it at the beginning. If omitted, the field is placed at the very end.

Example 1: Add a new 'subtitle' field after the 'title' field.
    const result = await tools.updateSchemaFieldStructure({
        schemaId: "tcm:2-104-8",
        operations: [
            {
                action: "add",
                fieldLocation: "Content",
                insertAfter: "title",
                fieldDefinition: {
                    type: "SingleLineTextFieldDefinition",
                    Name: "subtitle",
                    Description: "A brief subtitle",
                    MinOccurs: 0,
                    MaxOccurs: 1
                }
            }
        ]
    });

Example 2: Move the 'author' metadata field to the very top of the metadata section.
    const result = await tools.updateSchemaFieldStructure({
        schemaId: "tcm:2-104-8",
        operations: [
            {
                action: "move",
                fieldLocation: "Metadata",
                fieldName: "author",
                insertAfter: "[TOP]"
            }
        ]
    });
    
Example 3: Remove an obsolete field and apply to primary if inherited.
    const result = await tools.updateSchemaFieldStructure({
        schemaId: "tcm:5-213-8",
        applyToPrimary: true,
        operations: [
            {
                action: "remove",
                fieldLocation: "Content",
                fieldName: "legacyCode"
            }
        ]
    });
    `,

    input: updateSchemaFieldStructureInputProperties,

    execute: async (
        params: z.infer<typeof updateSchemaFieldStructureSchema>,
        context: any
    ) => {
        formatForApi(params);
        const { schemaId, operations, applyToPrimary } = params;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            let currentSchemaId = schemaId;
            let restItemId = currentSchemaId.replace(':', '_');
            
            // 1. Fetch the Schema from the API
            let getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            let itemToUpdate = getItemResponse.data;

            // 2. Perform BluePrint validation
            const bpInfo = itemToUpdate.BluePrintInfo;
            if (bpInfo && (bpInfo.IsShared || bpInfo.IsLocalized)) {
                const primaryId = bpInfo.PrimaryBluePrintParentItem?.IdRef;
                if (applyToPrimary && primaryId) {
                    currentSchemaId = primaryId;
                    restItemId = currentSchemaId.replace(':', '_');
                    // Re-fetch the primary item
                    getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
                    if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
                    itemToUpdate = getItemResponse.data;
                } else {
                    return createJsonError(`Schema ${currentSchemaId} is shared or localized and its XML structure cannot be modified here. You must update the primary item: ${primaryId || 'parent publication'}. Use 'applyToPrimary: true' to automatically apply changes to the parent.`);
                }
            }

            // 3. Convert API dictionaries into workable Arrays to manipulate sequences
            const contentFields: any[] = [];
            const metadataFields: any[] = [];

            if (itemToUpdate.Fields) {
                for (const key in itemToUpdate.Fields) {
                    if (key !== '$type' && key !== 'ExtensionXml') {
                        contentFields.push(itemToUpdate.Fields[key]);
                    }
                }
            }

            if (itemToUpdate.MetadataFields) {
                for (const key in itemToUpdate.MetadataFields) {
                    if (key !== '$type' && key !== 'ExtensionXml') {
                        metadataFields.push(itemToUpdate.MetadataFields[key]);
                    }
                }
            }

            // 4 & 5. Iterate operations and apply sequence logic
            for (let i = 0; i < operations.length; i++) {
                const op = operations[i];
                const targetArray = op.fieldLocation === 'Content' ? contentFields : metadataFields;

                if (op.action === 'remove') {
                    const idx = targetArray.findIndex(f => f.Name === op.fieldName);
                    if (idx === -1) {
                        return createJsonError(`Operation ${i + 1} failed: Cannot remove field '${op.fieldName}'. It does not exist in the ${op.fieldLocation} definition.`);
                    }
                    targetArray.splice(idx, 1);
                } 
                else if (op.action === 'add') {
                    formatForApi(op.fieldDefinition); // Make sure $type is properly formatted
                    const newFieldName = op.fieldDefinition?.Name;
                    
                    if (targetArray.some(f => f.Name === newFieldName)) {
                        return createJsonError(`Operation ${i + 1} failed: A field named '${newFieldName}' already exists in the ${op.fieldLocation} definition.`);
                    }

                    let insertIdx = targetArray.length; // Default to end
                    if (op.insertAfter === '[TOP]') {
                        insertIdx = 0;
                    } else if (op.insertAfter) {
                        const afterIdx = targetArray.findIndex(f => f.Name === op.insertAfter);
                        if (afterIdx === -1) {
                            return createJsonError(`Operation ${i + 1} failed: The 'insertAfter' field '${op.insertAfter}' was not found in the ${op.fieldLocation} definition.`);
                        }
                        insertIdx = afterIdx + 1;
                    }
                    targetArray.splice(insertIdx, 0, op.fieldDefinition);
                } 
                else if (op.action === 'move') {
                    const idx = targetArray.findIndex(f => f.Name === op.fieldName);
                    if (idx === -1) {
                        return createJsonError(`Operation ${i + 1} failed: Cannot move field '${op.fieldName}'. It does not exist in the ${op.fieldLocation} definition.`);
                    }
                    
                    // Remove from current position
                    const [movedField] = targetArray.splice(idx, 1);
                    
                    let insertIdx = targetArray.length; // Default to end
                    if (op.insertAfter === '[TOP]') {
                        insertIdx = 0;
                    } else if (op.insertAfter) {
                        const afterIdx = targetArray.findIndex(f => f.Name === op.insertAfter);
                        if (afterIdx === -1) {
                            return createJsonError(`Operation ${i + 1} failed: The 'insertAfter' field '${op.insertAfter}' was not found in the ${op.fieldLocation} definition.`);
                        }
                        insertIdx = afterIdx + 1;
                    }
                    
                    // Insert at new position
                    targetArray.splice(insertIdx, 0, movedField);
                }
            }

            // 6. Rebuild dictionaries strict to the newly sequenced array order
            if (contentFields.length > 0 || itemToUpdate.Fields) {
                const newFieldsDict: Record<string, any> = { "$type": "FieldsDefinitionDictionary" };
                contentFields.forEach(f => {
                    if (f.Name) newFieldsDict[f.Name] = f;
                });
                itemToUpdate.Fields = newFieldsDict;
            }

            if (metadataFields.length > 0 || itemToUpdate.MetadataFields) {
                const newMetadataDict: Record<string, any> = { "$type": "FieldsDefinitionDictionary" };
                metadataFields.forEach(f => {
                    if (f.Name) newMetadataDict[f.Name] = f;
                });
                itemToUpdate.MetadataFields = newMetadataDict;
            }

            const schemaLocationId = itemToUpdate.LocationInfo?.OrganizationalItem?.IdRef;
            if (!schemaLocationId) {
                return createJsonError(`Could not determine location for Schema ${currentSchemaId} to process structural updates.`);
            }

            // 8. Run updated dictionaries through processing to resolve embedded schemas/links
            if (itemToUpdate.Fields) {
                itemToUpdate.Fields = await processSchemaFieldDefinitions(itemToUpdate.Fields, schemaLocationId, authenticatedAxios);
            }
            if (itemToUpdate.MetadataFields) {
                itemToUpdate.MetadataFields = await processSchemaFieldDefinitions(itemToUpdate.MetadataFields, schemaLocationId, authenticatedAxios);
            }

            // 9. PUT the updated schema
            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) return handleUnexpectedResponse(updateResponse);

            // 10. Cache Invalidation
            invalidateSchemaCache(currentSchemaId);

            const updatedItem = updateResponse.data;
            const responseData = {
                type: updatedItem['$type'],
                Id: updatedItem.Id,
                Message: `Successfully updated structure for ${updatedItem.Id}`
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            await diagnoseBluePrintError(error, params, schemaId, authenticatedAxios);
            
            if (error instanceof Error) {
                return createJsonError(error.message);
            }
            return handleAxiosError(error, `Failed to update field structure for Schema ${schemaId}`);
        }
    }
};