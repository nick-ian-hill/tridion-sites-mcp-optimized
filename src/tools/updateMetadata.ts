import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

export const updateMetadata = {
    name: "updateMetadata",
    description: `Updates the metadata fields for a specific item in the Content Management System. Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in. If the item is already checked out by you, it will remain checked out after the update. The operation will be aborted if the item is checked out by another user.

Important Constraints:
- This tool only updates the metadata fields. It cannot update the item's Title or Content fields.

To update content fields for a component, use the 'updateContent' tool instead.
To update other properties, use the 'updateItemProperties', 'updatePage', or 'updatePublication' tool depending on the item type.

When populating a Component Link field (ComponentLinkFieldDefinition), the linked Component must be based on a Schema specified in that field's 'AllowedTargetSchemas' list. If you encounter a schema validation error on a component link field, use the following strategy:
- Use 'getItem' to retrieve the main Schema's definition.
- Inspect the AllowedTargetSchemas property for the specific field causing the error.
- Use the 'search' tool with the BasedOnSchemas filter to find a valid Component URI to use in the link.

To discover all available fields within an embedded schema, including optional ones, you must inspect the schema definition. Use the following strategy:
- Use getItem to retrieve the main Schema's definition.
- Locate the specific EmbeddedSchemaFieldDefinition within the Fields or MetadataFields.
- Inspect the EmbeddedFields property of that definition. This property contains a dictionary of all the fields (both mandatory and optional) that you can populate.

Examples:

Example 1: Updates the metadata fields with XML names 'Keywords' and 'Author' for a Component.
    const result = await tools.updateMetadata({
        "itemId": "tcm:5-123",
        "metadata": {
            "Keywords": ["Update", "Tool", "Metadata"],
            "Author": "Author Name"
        }
    });
    
Example 2: Updates the metadata values for a 'Folder' with featuring a multi-value embedded schema field.
    const result = await tools.updateMetadata({
        "itemId": "tcm:4-567-2",
        "metadata": {
            "Products": [
                {
                    "Description": {
                        type: "Link",
                        IdRef: "tcm:4-101"
                    },
                    "AvailableFrom": "2025-10-02T00:00:00",
                    "relatedProducts": [
                        {
                            "type": "Link",
                            "IdRef": "tcm:4-801"
                        },
                        {
                            "type": "Link",
                            "IdRef": "tcm:4-802"
                        }
                    ]
                },
                {
                    "Description": {
                        type: "Link",
                        IdRef: "tcm:4-102"
                    },
                    "AvailableFrom": "2025-10-02T00:00:00",
                    "relatedProducts": [
                        {
                            "type": "Link",
                            "IdRef": "tcm:4-803"
                        }
                    ]
                }
            ]
        }
    });
    `,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/).describe("The unique ID of the item to update (e.g., 'tcm:5-1234-64')."),
        metadata: z.record(fieldValueSchema).describe("A JSON object containing the item's metadata fields. The tool will automatically order the fields to match the Metadata Schema definition."),
    },
    execute: async ({ itemId, metadata }: { itemId: string, metadata: Record<string, any> }, context: any) => {
        formatForApi(metadata);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            
            const itemToUpdate = getItemResponse.data;
            
            let schemaIdForMetadata: string | undefined;

            if (itemToUpdate.MetadataSchema?.IdRef && itemToUpdate.MetadataSchema.IdRef !== 'tcm:0-0-0') {
                schemaIdForMetadata = itemToUpdate.MetadataSchema.IdRef;
            } 
            else if (itemToUpdate.$type === 'Component') {
                schemaIdForMetadata = itemToUpdate.Schema?.IdRef;
            }
            
            if (!schemaIdForMetadata) {
                return handleAxiosError(new Error(`Could not determine a valid Schema for the metadata fields of item ${itemId}.`), "Failed to update item metadata");
            }

            convertLinksRecursively(metadata, itemId);
            const orderedMetadata = await reorderFieldsBySchema(metadata, schemaIdForMetadata, 'metadata', authenticatedAxios);
            
            itemToUpdate.Metadata = orderedMetadata;

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }
            
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
            await diagnoseBluePrintError(error, metadata, itemId, authenticatedAxios);
            return handleAxiosError(error, "Failed to update item metadata");
        }
    }
};