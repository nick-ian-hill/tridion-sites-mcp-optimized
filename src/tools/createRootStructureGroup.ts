import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import axios from "axios";

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
        metadataSchemaId: z.string().regex(/^tcm:\d+-\d+(-\d+)?$/).optional().describe("The TCM URI of a Metadata Schema to apply to the root Structure Group."),
        metadata: z.record(z.any()).optional().describe("A JSON object containing the values for the metadata fields, structured according to the Metadata Schema.")
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
            // 1. Construct the payload manually using the provided minimal model
            const payload = {
                "$type": "StructureGroup",
                "Id": "tcm:0-0-0",
                "Title": title,
                "IsRootOrganizationalItem": true,
                "LocationInfo": {
                    "$type": "PublishLocationInfo",
                    "ContextRepository": {
                        "$type": "Link",
                        "IdRef": publicationId
                    }
                },
                "Metadata": metadata || { "$type": "FieldsValueDictionary" },
                "MetadataSchema": {
                    "$type": "Link",
                    "IdRef": metadataSchemaId || "tcm:0-0-0"
                }
            };
            
            // 2. Post the customized payload to the /items endpoint to create the item
            const createResponse = await authenticatedAxios.post('/items', payload);

            // A successful creation returns a 201 status code
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
                return {
                    content: [],
                    errors: [
                        { message: `Unexpected response status during item creation: ${createResponse.status}` },
                    ],
                };
            }

        } catch (error) {
            const errorMessage = axios.isAxiosError(error)
                ? (error.response ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message)
                : String(error);
            return {
                content: [],
                errors: [{ message: `Failed to create root Structure Group: ${errorMessage}` }],
            };
        }
    }
};