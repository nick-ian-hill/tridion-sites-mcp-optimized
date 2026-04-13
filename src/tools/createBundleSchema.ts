import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { processAndOrderFieldDefinitions, formatForApi, formatForAgent } from "../utils/fieldReordering.js";

export const createBundleSchema = {
    name: "createBundleSchema",
    summary: "Creates a new Schema of type 'Bundle' for defining metadata on collections of items.",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Bundle'.
    
Bundle Schemas define the metadata fields for Bundles. Bundles are collections of other CMS items, often used for workflow or publishing purposes.

The schema's structure is defined using the 'metadataFields' property.`,
    input: {
        title: z.string().nonempty().describe("The title for the new Bundle Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        metadataFields: z.array(fieldDefinitionSchema).optional().describe("An array of metadata field definitions for the schema. The order of the array determines the field order."),
        bundleProcessId: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of a Process Definition (workflow) to associate with this Bundle Schema. Any Bundle created using this schema, as well as its contained items, will be automatically routed through this workflow process for review and approval."),
        deleteBundleOnProcessFinished: z.boolean().optional().describe("If true, Bundles based on this Schema will be deleted when their workflow process finishes."),
        isIndexable: z.boolean().optional().describe("Specifies whether metadata values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether metadata values are published.")
    },
    execute: async (args: any, context: any) => {
        formatForApi(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, description, metadataFields,
            bundleProcessId, deleteBundleOnProcessFinished,
            isIndexable, isPublishable
        } = args;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const processedMetadataFields = metadataFields ? await processAndOrderFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Schema', {
                params: { containerId: locationId }
            });
            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.Purpose = "Bundle";
            delete payload.RootElementName;

            if (description) payload.Description = description;
            if (processedMetadataFields) payload.MetadataFields = processedMetadataFields;
            if (bundleProcessId) payload.BundleProcess = toLink(bundleProcessId);
            if (typeof deleteBundleOnProcessFinished === 'boolean') payload.DeleteBundleOnProcessFinished = deleteBundleOnProcessFinished;
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
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            return handleAxiosError(error, "Failed to create Bundle Schema");
        }
    },
    examples: [
        {
            description: "Create a simple Bundle Schema",
            payload: `const result = await tools.createBundleSchema({
        title: "Campaign Bundle Schema",
        locationId: "tcm:1-2-2",
        description: "A schema for campaign-related bundles.",
        metadataFields: [
            {
                "type": "SingleLineTextFieldDefinition",
                "Name": "campaignManager",
                "Description": "The manager of this campaign."
            }
        ]
    });`
        }
    ]
};