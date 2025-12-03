import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { reorderFieldsBySchema, convertLinksRecursively, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

const createComponentInputProperties = {
    title: z.string().nonempty().describe("The title for the new Component. Note that creation will fail if a Component with the same title already exists in the target Folder."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Component will be created. Use 'search' or 'getItemsInContainer' to find a suitable Folder."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).describe("The TCM URI of the Component Schema to use. This Schema MUST exist in the target Publication or a parent Publication. Use 'getSchemaLinks' with purpose 'Component' to find available Schemas."),
    content: z.record(fieldValueSchema).optional().describe("A JSON object for the Component's content fields, matching the 'fields' defined on its Schema. The tool will automatically order the fields to match the Schema definition."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the Component's metadata fields. This will ONLY work if the Component Schema (specified in 'schemaId') has 'metadataFields' defined. The tool will automatically order the fields to match the Schema's metadata definition.")
};

const createComponentInputSchema = z.object(createComponentInputProperties);

type CreateComponentInput = z.infer<typeof createComponentInputSchema>;

export const createComponent = {
    name: "createComponent",
    description: `Creates a new Content Manager System (CMS) item of type 'Component'.
This is the dedicated tool for creating content Components. It simplifies the process and ensures correct metadata handling.

IMPORTANT: To add metadata to a Component, you must use a Component Schema that has the 'metadataFields' property defined (use 'createComponentSchema' to create such a schema).
You then provide the metadata values using the 'metadata' parameter of THIS tool.
This tool does NOT support linking a separate Metadata Schema.

BluePrint Context & 404 Errors:
The component schema (referenced via 'schemaId'), and any other items you reference via the content or metadata properties (e.g., Keywords), MUST exist in the same Publication as 'locationId'.
If any IDs reference items in a parent or other ancestor Publication, the items will be inherited by the context Publication, and the tool will map the IDs to the correct context automatically.
For example, if you are in 'locationId' "tcm:107-..." (Child) and use 'schemaId' "tcm:105-..." (Parent), the tool correctly maps this to the inherited ID "tcm:107-...".

If you get a 404 'Not Found' error for an item you trying to reference (e.g., a Schema or Keyword) it likely means the item is in a sibling or child Publication, not a parent or other ancestor.
Items created in sibling/child Pubications are not inherited, and therefore the mapped ID will not correspond to a real item.
In this scenario, you will either need to
- find an alternative item that already exists in the context Publication,
- create a new item in the context Publication or a parent/ancestor, or
- promote the item(s) you are trying to reference to a parent or ancestor Publication using the 'promoteItem' tool.

To find the parent Publications, call getItem on your current Publication URI (e.g., 'tcm:0-99-1') and set includeProperties to ['Parents'].

When populating a Component Link field (ComponentLinkFieldDefinition), the linked Component must be based on a Schema specified in that field's 'AllowedTargetSchemas' list.
If you encounter a schema validation error on a component link field, use the following strategy:
- Use 'getItem' to retrieve the main Schema's definition.
- Inspect the AllowedTargetSchemas property for the specific field causing the error.
- Use the 'search' tool with the BasedOnSchemas filter to find a valid Component URI to use in the link.

Examples:

Example 1: Create a simple Component with only content fields.
    const result = await tools.createComponent({
        itemType: "Component",
        locationId: "tcm:5-53-2",
        title: "Site Header",
        schemaId: "tcm:5-72-8",
        content: {
            "siteTitle": "Global News Network",
            "tagline": "Your trusted source for news"
        }
    });

Example 2: Create a Component with both content fields and metadata fields.
    const result = await tools.createComponent({
        itemType: "Component",
        locationId: "tcm:5-53-2",
        title: "New AI Breakthrough Article",
        schemaId: "tcm:5-74-8",
        content: {
            "headline": "New AI Model Surpasses Human Benchmarks",
            "body": "<p>Today, researchers announced a new model...</p>",
            "author": {
                "name": "Dr. Alex Chen",
                "biography": "Lead AI researcher."
            }
        },
        metadata: {
            "category": {
                "type": "Link",
                "IdRef": "tcm:5-189-1024"
            },
            "seoKeywords": "AI, Technology, Breakthrough"
        }
    });
`,
    input: createComponentInputProperties,

    execute: async (args: CreateComponentInput,
        context: any
    ) => {
        formatForApi(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        let { locationId, schemaId, title, content, metadata } = args;
        
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            schemaId = convertItemIdToContextPublication(schemaId, locationId);
            if (content) {
                convertLinksRecursively(content, locationId);
            }
            if (metadata) {
                convertLinksRecursively(metadata, locationId);
            }
        
            // Reorder content and metadata fields based on the Component Schema.
            if (content) {
                content = await reorderFieldsBySchema(content, schemaId, 'content', authenticatedAxios);
            }
            if (metadata) {
                metadata = await reorderFieldsBySchema(metadata, schemaId, 'metadata', authenticatedAxios);
            }

            // 1. Get the default model for the item type and location
            const defaultModelResponse = await authenticatedAxios.get(`/item/defaultModel/Component`, {
                params: {
                    containerId: locationId
                }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            // 2. Customize the payload
            payload.Title = title;
            payload.Schema = toLink(schemaId);
            
            if (content) payload.Content = content;
            if (metadata) payload.Metadata = metadata;
            
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

            // 3. Post the payload to create the item
            const createResponse = await authenticatedAxios.post('/items', payload);
            if (createResponse.status === 201) {
                let responseData;
                if (createResponse.data) {
                    responseData = {
                        $type: createResponse.data['$type'],
                        Id: createResponse.data.Id,
                        Message: `Successfully created ${createResponse.data.Id}`
                    };
                }
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedResponseData, null, 2)
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            await diagnoseBluePrintError(error, args, locationId, authenticatedAxios);
            return handleAxiosError(error, "Failed to create Component");
        }
    }
};