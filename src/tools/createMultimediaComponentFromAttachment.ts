import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { formatForAgent, formatForApi } from "../utils/fieldReordering.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";

const createMultimediaComponentFromAttachmentInputProperties = {
    attachmentId: z.string().describe(
        "The temporary file ID returned when the user uploaded the file. Use the 'tempFileId' value from the attachment context.",
    ),
    fileName: z.string().describe(
        "The desired file name for the multimedia component in the CMS (e.g., 'product-image.jpg'). Use the 'fileName' from the attachment context, or a corrected version if the user specified a different name.",
    ),
    title: z.string().describe("The title for the new multimedia component."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe(
        "The TCM URI of the parent Folder where the new component will be created. Use 'search' or 'getItemsInContainer' to find a suitable Folder.",
    ),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe(
        "The TCM URI of the Multimedia Schema to use. If not provided, a default will be determined automatically. Use 'getSchemaLinks' with purpose 'Multimedia' to find available schemas.",
    ),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields."),
};

const createMultimediaComponentFromAttachmentSchema = z.object(createMultimediaComponentFromAttachmentInputProperties);

export const createMultimediaComponentFromAttachment = {
    name: "createMultimediaComponentFromAttachment",
    summary: "Creates a Multimedia Component from a file that was uploaded or attached by the user.",
    description: `Creates a new multimedia component directly from a file that was attached by the user.

Use this tool when the user has attached a file (image, video, PDF, etc.) AND wants to save it as a new multimedia component in the CMS.

This is more efficient than 'createMultimediaComponentFromBase64' for user-attached files because the file is already in temporary CMS storage — no download or re-upload is needed.

If the user wants to **read or analyse** the content of an attached file instead, use 'readUploadedFile'.`,
    input: createMultimediaComponentFromAttachmentInputProperties,
    async execute(input: z.infer<typeof createMultimediaComponentFromAttachmentSchema>, context: any) {
        formatForApi(input);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { attachmentId, fileName, title, locationId, schemaId, metadata } = input;

        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            // The attachmentId from a browser upload is already a CMS temporary file ID —
            // it was created by the same POST /binary/upload endpoint the CMS uses internally.
            // We can therefore use it directly as BinaryContent.UploadFromFile without
            // a download + re-upload round trip.
            console.log(`Using attached file '${fileName}' (attachmentId: ${attachmentId}) to create multimedia component in ${locationId}...`);

            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Component', {
                params: { containerId: locationId },
            });

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }

            const payload = defaultModelResponse.data;
            payload.Title = title;
            payload.ComponentType = 'Multimedia';

            // Schema selection — mirrors createMultimediaComponentFromBase64
            if (payload.IsBasedOnMandatorySchema) {
                console.log(`Using mandatory schema '${payload.Schema?.Title}' (${payload.Schema?.IdRef}) defined on the folder.`);
            } else if (schemaId) {
                console.log(`Using user-provided schema: ${schemaId}`);
                payload.Schema = { ...payload.Schema, IdRef: schemaId };
            } else if (payload.Schema?.IdRef && payload.Schema.IdRef !== 'tcm:0-0-0') {
                console.log(`Using default schema '${payload.Schema?.Title}' (${payload.Schema?.IdRef}) from the default model.`);
            } else {
                console.log('No mandatory, user-provided, or default schema found. Looking up Publication\'s default multimedia schema.');
                const publicationId = payload.LocationInfo?.ContextRepository?.IdRef;
                if (!publicationId) {
                    throw new Error('Could not determine the Publication context from the default model.');
                }

                const restPublicationId = publicationId.replace(':', '_');
                console.log(`Fetching details for Publication: ${publicationId}`);
                const publicationResponse = await authenticatedAxios.get(`/items/${restPublicationId}`);

                if (publicationResponse.status !== 200) {
                    return handleUnexpectedResponse(publicationResponse);
                }

                const defaultMultimediaSchemaId = publicationResponse.data?.DefaultMultimediaSchema?.IdRef;
                if (!defaultMultimediaSchemaId || defaultMultimediaSchemaId === 'tcm:0-0-0') {
                    throw new Error(`The Publication (${publicationId}) does not have a Default Multimedia Schema defined.`);
                }

                console.log(`Using Publication's default multimedia schema: ${defaultMultimediaSchemaId}`);
                payload.Schema = { ...payload.Schema, IdRef: defaultMultimediaSchemaId };
            }

            if (metadata) {
                payload.Metadata = metadata;
            }

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: { IdRef: locationId } };
            }

            payload.BinaryContent = {
                ...payload.BinaryContent,
                UploadFromFile: attachmentId,
                Filename: fileName,
            };

            console.log('Creating multimedia component...');
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                console.log(`Successfully created component with ID: ${createResponse.data.Id}`);
                const responseData = createResponse.data?.Id
                    ? {
                        $type: createResponse.data['$type'],
                        Id: createResponse.data.Id,
                        Message: `Successfully created ${createResponse.data.Id}`,
                    }
                    : undefined;
                return {
                    content: [{ type: 'text', text: JSON.stringify(formatForAgent(responseData), null, 2) }],
                };
            }

            return handleUnexpectedResponse(createResponse);
        } catch (error) {
            await diagnoseBluePrintError(error, input, locationId, authenticatedAxios);
            return handleAxiosError(error, `Failed to create multimedia component from attached file '${fileName}'`);
        }
    },
    examples: [
    ]
};
