import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi, deepMerge } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

export const updateContent = {
    name: "updateContent",
    description: `Updates the content fields for an item of type 'Component' in the Content Management System. Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in.

Partial Updates Supported:
- You only need to provide the fields you wish to change.
- The tool performs a recursive "deep merge":
  - **Objects**: Merged (e.g., if updating 'Address.City', 'Address.Zip' is preserved).
  - **Arrays**: Replaced (e.g., providing a new list of 'Tags' overwrites the old list entirely).
  - **Primitives**: Overwritten.

Important Constraints:
- This tool is only for Components. It cannot update other item types.
- This tool only updates the content fields and cannot be used to update other properties like Title or Metadata.

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
- Inspect the EmbeddedFields property of that definition. This property contains a dictionary of all the fields (both mandatory and optional) that you can populate.

Examples:

Example 1: Updates ONLY the 'TitleField', preserving other existing content fields.
    const result = await tools.updateContent({
        "itemId": "tcm:5-123",
        "content": {
            "TitleField": "Updated Component Title" 
        }
    });
    
Example 2: Updates a specific field deep inside an embedded schema, preserving siblings.
    const result = await tools.updateContent({
        "itemId": "tcm:5-123",
        "content": {
            "sourceAttribution": {
                // This updates 'authorName' but keeps 'publication' and 'relatedArticles' if they exist.
                "authorName": "Dr. Ellie Sattler"
            }
        }
    });
    `,
    input: {
        itemId: z.string().regex(/^(tcm:\d+-\d+(-16)?)$/).describe("The unique ID of the component to update (e.g., 'tcm:5-123')."),
        content: z.record(fieldValueSchema).describe("A JSON object containing the Component's content fields to update. Partial updates are supported."),
    },
    execute: async ({ itemId, content }: { itemId: string, content: Record<string, any> }, context: any) => {
        formatForApi(content);
        const diagnosticsArgs = JSON.parse(JSON.stringify(content));
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const restItemId = itemId.replace(':', '_');
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

            // Fetch existing content and merge with new input
            const existingContent = itemToUpdate.Content || {};
            const mergedContent = deepMerge(existingContent, content);

            // Reorder based on the full merged object
            const orderedContent = await reorderFieldsBySchema(mergedContent, schemaId, 'content', authenticatedAxios);

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
    }
};