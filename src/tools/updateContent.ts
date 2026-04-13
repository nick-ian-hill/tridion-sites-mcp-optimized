import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi, deepMerge } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

export const updateContent = {
    name: "updateContent",
    summary: "Updates the content fields of an existing Component. Use this for modifying text, images, or links within a content item.",
    description: `Updates the content fields for an item of type 'Component' in the Content Management System. Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in.

Partial Updates Supported:
- You only need to provide the fields you wish to change.
- The 'updateMode' parameter controls how your input interacts with the existing data.

Update Modes:
1. **'replace'** (Default): 
   - The content object you provide **REPLACES** the existing content structure.
   - Any **content fields** NOT present in your input (but present on the item) will be **REMOVED**.
   - Arrays are completely overwritten.
   - *Use this when you want to set the exact state of the content, removing anything you didn't explicitly include.*

2. **'update'**:
   - **"Smart Merge"**: Your input is merged into the existing content.
   - **Objects**: Recursively merged. Keys you omit are **PRESERVED**.
     - *Note*: Merging only works if the target field already exists on the item. If a field is currently null/missing on the server, you must provide all mandatory sub-fields, as there is nothing to merge with.
   - **Arrays**: Merged by index.
     - **Constraint**: Multi-value fields MUST be provided as arrays (e.g., \`[{...}]\`), even if you are only updating a single item.
     - **Skips**: If you provide \`null\` at an index (e.g., \`[null, "New"]\`), the existing value at that index is **PRESERVED**.
     - **Partial Objects**: If you provide a partial object (e.g., \`[{ "Age": 30 }]\`), it merges into the existing object at that index.
     - New items are appended. Existing items beyond the input length are preserved.
   - *Use this when you want to modify specific properties (like updating one field in an embedded schema) without having to resend the entire structure.*

Important Constraints:
- This tool is only for Components. It cannot update other item types.
- This tool only updates the content fields and cannot be used to update other properties like Title or Metadata.
- **BluePrint Restrictions**: You can only update an item if it is the primary (owning) item or a 'Localized' copy. You **cannot** update a 'Shared' (inherited) copy directly. To modify a Shared item, it must first be localized, or the primary item must be updated in its owning parent publication.
- **Non-Localizable Fields**: When updating a Localized copy, you **cannot** modify fields where their Schema definition sets 'IsLocalizable' to 'false'. To change these specific fields, you must update the primary (owning) item instead.
- **Lock State**: The item must not be locked or checked out by another user. If it is, the update will be rejected by the server.

To update metadata, use the 'updateMetadata' tool.
To update other properties, use the 'updateItemProperties' tool.

When providing values for an embedded schema field, the data structure is a flat JSON object (for a single-value field) or an array of flat objects (for a multi-value field).

When populating a Component Link field (ComponentLinkFieldDefinition), the linked Component must be based on a Schema specified in that field's 'AllowedTargetSchemas' list. If you encounter a schema validation error on a component link field, use the following strategy:
- Use 'getItem' to retrieve the main Schema's definition.
- Inspect the AllowedTargetSchemas property for the specific field causing the error.
- Use the 'search' tool with the BasedOnSchemas filter to find a valid Component URI to use in the link.

To discover all available fields within an embedded schema, including optional ones, you must inspect the schema definition. Use the following strategy:
- Use getItem to retrieve the main Schema's definition.
- Locate the specific EmbeddedSchemaFieldDefinition within the Fields or MetadataFields.
- Inspect the EmbeddedFields property of that definition. This property contains a dictionary of all the fields (both mandatory and optional) that you can populate.`,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?)$/).describe("The unique ID of the component to update (e.g., 'tcm:5-123')."),
        content: z.record(fieldValueSchema).describe("A JSON object containing the Component's content fields to update."),
        updateMode: z.enum(['replace', 'update']).default('replace').describe("Strategy for applying changes. 'replace' overwrites the provided structure. 'update' performs a smart merge (recursive object merge + array merge by index with null skipping)."),
    },
    execute: async ({ itemId, content, updateMode }: { itemId: string, content: Record<string, any>, updateMode: 'replace' | 'update' }, context: any) => {
        formatForApi(content);
        const diagnosticsArgs = JSON.parse(JSON.stringify(content));
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const normalizedItemId = itemId.replace(/-16$/, '');
        const restItemId = normalizedItemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const getInitialItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getInitialItemResponse.status !== 200) {
                return handleUnexpectedResponse(getInitialItemResponse);
            }
            const itemToUpdate = getInitialItemResponse.data;
            const schemaId = itemToUpdate.Schema?.IdRef;

            if (!schemaId) {
                return handleAxiosError(new Error(`Component ${itemId} does not have an associated Schema.`), "Failed to update component");
            }

            convertLinksRecursively(content, itemId);

            let newContent: Record<string, any>;

            if (updateMode === 'replace') {
                // In replace mode, the input IS the new content.
                // We rely on reorderFieldsBySchema to structure it correctly, 
                // but we do NOT merge with existing values.
                newContent = content;
            } else {
                // In update mode, we perform a smart merge with existing data.
                const existingContent = itemToUpdate.Content || {};
                newContent = deepMerge(existingContent, content);
            }

            // Reorder based on the full object
            const orderedContent = await reorderFieldsBySchema(newContent, schemaId, 'content', authenticatedAxios);

            itemToUpdate.Content = orderedContent;

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
            return handleAxiosError(error, "Failed to update component");
        }
    },
    examples: [
        {
            description: "REPLACE 'TitleField'. Even if other fields existed, using 'replace' with ONLY TitleField will attempt to save a Component with ONLY TitleField (likely failing schema validation if other fields are mandatory). Use 'replace' when you have the FULL desired state of the component content.",
            payload: `const result = await tools.updateContent({
        "itemId": "tcm:5-123",
        "updateMode": "replace", 
        "content": {
            "TitleField": "Updated Component Title" 
        }
    });`
        },
        {
            description: "Smart Update - Updates a specific field deep inside a list of embedded schemas. Existing 'Team' list: [{ \"Name\": \"Alice\", \"Role\": \"Dev\" }, { \"Name\": \"Bob\", \"Role\": \"QA\" }].",
            payload: `const result = await tools.updateContent({
        "itemId": "tcm:5-123",
        "updateMode": "update",
        "content": {
            "Team": [
                {
                    // This merges into index 0 (Alice), changing her Role but keeping Name="Alice".
                    "Role": "Lead Developer"
                },
                null // Index 1: PRESERVED (Bob) by passing null
            ]
        }
    });`
        }
    ]
};