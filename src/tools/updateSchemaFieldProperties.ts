import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { processSchemaFieldDefinitions } from "../utils/fieldReordering.js";

const fieldUpdateSchema = z.object({
    fieldName: z.string().describe("The XML name of the field to modify (e.g., 'articleBody')."),
    fieldLocation: z.enum(["Content", "Metadata"]).describe("Specifies whether the field is in the 'Content' or 'Metadata' definition."),
    propertyToUpdate: z.string().describe("The name of the property to change, using dot notation for nested properties (e.g., 'MinOccurs', 'List.Type')."),
    newValue: z.any().describe("The new value for the property. Can be a string, number, boolean, or a JSON object for complex properties like 'AllowedTargetSchemas'.")
});

const updateSchemaFieldPropertiesInputProperties = {
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The unique ID (TCM URI) of the Schema to update."),
    fieldUpdates: z.array(fieldUpdateSchema).min(1).describe("An array of update operations to perform on the Schema's fields.")
};

const updateSchemaFieldPropertiesSchema = z.object(updateSchemaFieldPropertiesInputProperties);

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

export const updateSchemaFieldProperties = {
    name: "updateSchemaFieldProperties",
    description: `Updates specific properties of one or more fields within a given Schema. This is more efficient than replacing the entire fields collection.
    
Check-out and check-in of the Schema are handled automatically.

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
    `,

    input: updateSchemaFieldPropertiesInputProperties,
    
    execute: async (
        params: z.infer<typeof updateSchemaFieldPropertiesSchema>, 
        context: any
    ) => {
        const { schemaId, fieldUpdates } = params;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const restItemId = schemaId.replace(':', '_');
        let wasCheckedOutByTool = false;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            let itemToUpdate = getItemResponse.data;

            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            if (whoAmIResponse.status !== 200) return handleUnexpectedResponse(whoAmIResponse);
            const agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) throw new Error("Could not retrieve agent's user ID.");

            const isCheckedOut = itemToUpdate?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = itemToUpdate?.VersionInfo?.CheckOutUser?.IdRef;
            if (isCheckedOut && checkedOutUser !== agentId) return { content: [{ type: "text", text: `Schema ${schemaId} is already checked out by another user.` }] };
            if (!isCheckedOut) {
                const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, { "$type": "CheckOutRequest", "SetPermanentLock": true });
                if (checkOutResponse.status !== 200) return handleUnexpectedResponse(checkOutResponse);
                itemToUpdate = checkOutResponse.data;
                wasCheckedOutByTool = true;
            }

            for (const update of fieldUpdates) {
                const { fieldName, fieldLocation, propertyToUpdate, newValue } = update;
                const fieldCollection = fieldLocation === 'Content' ? itemToUpdate.Fields : itemToUpdate.MetadataFields;

                if (!fieldCollection) {
                    throw new Error(`Schema ${schemaId} does not have a '${fieldLocation}' fields definition.`);
                }

                const fieldToUpdate = fieldCollection[fieldName];
                if (!fieldToUpdate) {
                    throw new Error(`Field '${fieldName}' not found in the '${fieldLocation}' definition of Schema ${schemaId}.`);
                }

                setNestedProperty(fieldToUpdate, propertyToUpdate, newValue);
            }

            const schemaLocationId = itemToUpdate.LocationInfo?.OrganizationalItem?.IdRef;
            if (!schemaLocationId) {
                throw new Error(`Could not determine location for Schema ${schemaId} to process field updates.`);
            }

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

            // Handle check-in
            if (wasCheckedOutByTool) {
                const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
                if (checkInResponse.status !== 200) return handleUnexpectedResponse(checkInResponse);
            }

            return {
                content: [{ type: "text", text: `Successfully updated fields in Schema ${schemaId}.\n\n${JSON.stringify(updatedItem, null, 2)}` }],
            };

        } catch (error) {
            if (wasCheckedOutByTool) {
                try { await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`); } 
                catch (undoError) { console.error(`Failed to undo checkout for Schema ${schemaId}: ${String(undoError)}`); }
            }
            return handleAxiosError(error, `Failed to update fields for Schema ${schemaId}`);
        }
    }
};