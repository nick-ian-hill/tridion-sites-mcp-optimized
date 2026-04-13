import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi, deepMerge } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

export const updateMetadata = {
    name: "updateMetadata",
    summary: "Updates the metadata fields of an existing item. Use this for modifying administrative data, SEO fields, or classifications.",
    description: `Updates the metadata fields for a specific item in the Content Management System. Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in.

Partial Updates Supported:
- You only need to provide the fields you wish to change.
- The 'updateMode' parameter controls how your input interacts with the existing data.

Update Modes:
1. **'replace'** (Default): 
   - The metadata object you provide **REPLACES** the existing metadata structure.
   - Any **metadata fields** NOT present in your input (but present on the item) will be **REMOVED**.
   - Arrays are completely overwritten.
   - *Use this when you want to set the exact state of the metadata, removing anything you didn't explicitly include.*

2. **'update'**:
   - **"Smart Merge"**: Your input is merged into the existing metadata.
   - **Objects**: Recursively merged. Keys you omit are **PRESERVED**.
     - *Note*: Merging only works if the target field already exists on the item. If a field is currently null/missing on the server, you must provide all mandatory sub-fields, as there is nothing to merge with.
   - **Arrays**: Merged by index.
     - **Constraint**: Multi-value fields MUST be provided as arrays (e.g., \`[{...}]\`), even if you are only updating a single item.
     - **Skips**: If you provide \`null\` at an index (e.g., \`[null, "New"]\`), the existing value at that index is **PRESERVED**.
     - **Partial Objects**: If you provide a partial object (e.g., \`[{ "Age": 30 }]\`), it merges into the existing object at that index.
     - New items are appended. Existing items beyond the input length are preserved.
   - *Use this when you want to modify specific properties (like updating one field in an embedded schema) without having to resend the entire structure.*

Important Constraints:
- This tool only updates the metadata fields. It cannot update the item's Title or Content fields.
- **BluePrint Restrictions**: You can only update an item if it is the primary (owning) item or a 'Localized' copy. You **cannot** update a 'Shared' (inherited) copy directly. To modify a Shared item, it must first be localized, or the primary item must be updated in its owning parent publication.
- **Non-Localizable Fields**: When updating a Localized copy, you **cannot** modify fields where their Schema definition sets 'IsLocalizable' to 'false'. To change these specific fields, you must update the primary (owning) item instead.
- **Lock State**: The item must not be locked or checked out by another user. If it is, the update will be rejected by the server.

To update content fields for a component, use the 'updateContent' tool instead.
To update other properties, use the 'updateItemProperties', 'updatePage', or 'updatePublication' tool depending on the item type.

When populating a Component Link field (ComponentLinkFieldDefinition), the linked Component must be based on a Schema specified in that field's 'AllowedTargetSchemas' list. If you encounter a schema validation error on a component link field, use the following strategy:
- Use 'getItem' to retrieve the main Schema's definition.
- Inspect the AllowedTargetSchemas property for the specific field causing the error.
- Use the 'search' tool with the BasedOnSchemas filter to find a valid Component URI to use in the link.

To discover all available fields within an embedded schema, including optional ones, you must inspect the schema definition. Use the following strategy:
- Use getItem to retrieve the main Schema's definition.
- Locate the specific EmbeddedSchemaFieldDefinition within the Fields or MetadataFields.
- Inspect the EmbeddedFields property of that definition. This property contains a dictionary of all the fields (both mandatory and optional) that you can populate.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/).describe("The unique ID of the item to update (e.g., 'tcm:5-1234-64')."),
        metadata: z.record(fieldValueSchema).describe("A JSON object containing the item's metadata fields to update."),
        updateMode: z.enum(['replace', 'update']).default('replace').describe("Strategy for applying changes. 'replace' overwrites the provided structure. 'update' performs a smart merge (recursive object merge + array merge by index with null skipping)."),
    },
    execute: async ({ itemId, metadata, updateMode }: { itemId: string, metadata: Record<string, any>, updateMode: 'replace' | 'update' }, context: any) => {
        formatForApi(metadata);
        const diagnosticsArgs = JSON.parse(JSON.stringify(metadata));
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const restItemId = itemId
            .replace(/-16$/, '')
            .replace(':', '_');
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

            let newMetadata: Record<string, any>;

            if (updateMode === 'replace') {
                // In replace mode, the input IS the new metadata.
                // We rely on reorderFieldsBySchema to structure it correctly, 
                // but we do NOT merge with existing values.
                newMetadata = metadata;
            } else {
                // In update mode, we perform a smart merge with existing data.
                const existingMetadata = itemToUpdate.Metadata || {};
                newMetadata = deepMerge(existingMetadata, metadata);
            }

            // Reorder based on the full object
            const orderedMetadata = await reorderFieldsBySchema(newMetadata, schemaIdForMetadata, 'metadata', authenticatedAxios);

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
            await diagnoseBluePrintError(error, diagnosticsArgs, itemId, authenticatedAxios);
            return handleAxiosError(error, "Failed to update item metadata");
        }
    },
    examples: [
        {
            description: `REPLACE 'Keywords'. If existing metadata had "Keywords": ["Old"] and "Author": "Me". This input will result in "Keywords": ["New"] and "Author": "Me" (Author is preserved because it's a sibling, assuming "metadata" here is partial).`,
            payload: `const result = await tools.updateMetadata({
        "itemId": "tcm:5-123",
        "updateMode": "replace", 
        "metadata": {
            "Keywords": ["New"] 
        }
    });`
        },
        {
            description: `Smart Update of an Embedded Schema List. Existing 'Products' list: ["A", "B", "C"]. We want to change the second item ("B") to "Z", keeping "A" and "C".`,
            payload: `const result = await tools.updateMetadata({
        "itemId": "tcm:4-567-2",
        "updateMode": "update",
        "metadata": {
            "Products": [
                null, // Index 0: PRESERVED ("A")
                "Z"   // Index 1: UPDATED ("Z")
                      // Index 2: PRESERVED ("C") automatically
            ]
        }
    });`
        }
    ]
};