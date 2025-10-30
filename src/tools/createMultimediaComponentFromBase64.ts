import { z } from "zod";
import FormData from "form-data";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

const createMultimediaComponentFromBase64InputProperties = {
    base64Content: z.string().describe("The base64 encoded content of the file to upload."),
    title: z.string().describe("The title for the new multimedia component."),
    fileName: z.string().describe("The desired file name for the multimedia component in the CMS (e.g., 'product-image.jpg')."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new component will be created. Use 'search' or 'getItemsInContainer' to find a suitable Folder."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Multimedia Schema to use. If not provided, a default will be determined automatically. Use 'getSchemaLinks' with purpose 'Multimedia' to find available schemas."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields.")
};

const createMultimediaComponentFromBase64Schema = z.object(createMultimediaComponentFromBase64InputProperties);

export const createMultimediaComponentFromBase64 = {
    name: "createMultimediaComponentFromBase64",
    description: "Creates a new multimedia component by uploading a file from a base64 encoded string. If the parent Folder has a mandatory schema, it will be used automatically, so there is no need to provide a schemaId in this case. This is one of three ways to create a multimedia component, with the others being 'createMultimediaComponentFromUrl' and 'createMultimediaComponentFromPrompt'.",
    input: createMultimediaComponentFromBase64InputProperties,
    async execute(input: z.infer<typeof createMultimediaComponentFromBase64Schema>,
        context: any
    ) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { base64Content, title, fileName, locationId, schemaId, metadata } = input;
        
        try {
            // --- Part 1: Decode Base64 and Prepare for Upload ---
            const fileBuffer = Buffer.from(base64Content, 'base64');
            console.log(`Successfully decoded base64 content. Size: ${fileBuffer.length} bytes.`);

            const formData = new FormData();
            formData.append('file', fileBuffer, fileName);

            console.log("Uploading binary data to CMS temporary storage...");
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const uploadResponse = await authenticatedAxios.post('/binary/upload', formData, {
                headers: formData.getHeaders()
            });

            if (uploadResponse.status !== 202) {
                return handleUnexpectedResponse(uploadResponse);
            }
            
            const cmsTempFileId = uploadResponse.data.TempFileId;
            console.log(`Binary uploaded successfully. CMS Temporary File ID: ${cmsTempFileId}`);

            // --- Part 2: Component Creation Logic ---
            console.log(`Getting default model for a new component in container: ${locationId}`);
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/Component', {
                params: { containerId: locationId }
            });

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            payload.Title = title;
            payload.ComponentType = "Multimedia";

            // --- Schema Selection Logic ---
            if (payload.IsBasedOnMandatorySchema) {
                console.log(`Using mandatory schema '${payload.Schema?.Title}' (${payload.Schema?.IdRef}) defined on the folder.`);
            } else if (schemaId) {
                console.log(`Using user-provided schema: ${schemaId}`);
                payload.Schema = { ...payload.Schema, IdRef: schemaId };
            } else if (payload.Schema?.IdRef && payload.Schema.IdRef !== 'tcm:0-0-0') {
                console.log(`Using default schema '${payload.Schema?.Title}' (${payload.Schema?.IdRef}) from the default model.`);
            } else {
                console.log("No mandatory, user-provided, or default schema found. Looking up Publication's default multimedia schema.");
                const publicationId = payload.LocationInfo?.ContextRepository?.IdRef;
                if (!publicationId) {
                    throw new Error("Could not determine the Publication context from the default model.");
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
                UploadFromFile: cmsTempFileId,
                Filename: fileName,
            };

            console.log("Creating multimedia component...");
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                console.log(`Successfully created component with ID: ${createResponse.data.Id}`);
                let responseData;
                if (createResponse.data && createResponse.data.Id) {
                    responseData = {
                        $type: createResponse.data['$type'],
                        Id: createResponse.data.Id,
                        Message: `Successfully created ${createResponse.data.Id}`
                    };
                }
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            return handleAxiosError(error, "Failed to create multimedia component from base64");
        }
    }
};