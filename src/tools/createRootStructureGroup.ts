import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

export const createRootStructureGroup = {
    name: "createRootStructureGroup",
    description: `Creates a root Structure Group for the specified Publication.
    This is only required for a root Publication – a Publication that has no parent Publications – when the root Publication is used for constructing a BluePrint hierarchy.
    Children of the root Publication will automatically inherit the root Structure Group and its content
    A BluePrint hierarchy enables content reuse via inheritance.
    To modify a shared (i.e., inherited) item in a child Publication, it first needs to be 'localized in the child Publication.
    After localization, changes to a field value in the primary item will not impact the value in the localized item, unless the field is set to 'non-localizable' in the Schema.`,
    input: {
        title: z.string().describe("The title for the new root Structure Group."),
        publicationId: z.string().regex(/^tcm:0-\d+-1$/).describe("The TCM URI of the root Publication that will contain this Structure Group."),
        metadataSchemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of a Metadata Schema to apply to the root Structure Group."),
        metadata: z.record(fieldValueSchema).optional().describe("A JSON object containing the values for the metadata fields, structured according to the Metadata Schema.")
    },
    examples: [
        {
            input: {
                title: "Website Root",
                publicationId: "tcm:0-10-1"
            },
            description: "Creates a simple root Structure Group named 'Website Root' in the Publication with ID tcm:0-10-1."
        },
        {
            input: {
                title: "Root for Global Site",
                publicationId: "tcm:0-1-1",
                metadataSchemaId: "tcm:1-123-8",
                metadata: {
                    "siteName": "Global",
                    "region": "Worldwide"
                }
            },
            description: "Creates a root Structure Group with a title and applies metadata to it within Publication tcm:0-1-1."
        }
    ],
    execute: async (args: { title: string; publicationId: string; metadataSchemaId?: string; metadata?: Record<string, any> }) => {
        const { title, publicationId, metadataSchemaId, metadata } = args;

        try {
            // 1. Get the default model for a Structure Group, using the Publication as the container.
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/StructureGroup', {
                params: { containerId: publicationId }
            });

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            
            const payload = defaultModelResponse.data;

            // 2. Customize the payload
            payload.Title = title;

            if (metadata) {
                payload.Metadata = metadata;
            }
            if (metadataSchemaId) {
                payload.MetadataSchema = { ...payload.MetadataSchema, IdRef: metadataSchemaId };
            }
            
            // 3. Post the customized payload to the /items endpoint to create the item
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully created root Structure Group with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            return handleAxiosError(error, "Failed to create root Structure Group");
        }
    }
};