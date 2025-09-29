import { z } from "zod";
import axios from "axios";
import FormData from "form-data";
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";

const createMultimediaComponentFromUrlInputProperties = {
    mediaUrl: z.string().url().describe("The public URL of the file that will be used for the multimedia component. Must be a fully qualified URL including http:// or https://."),
    title: z.string().describe("The title for the new multimedia component."),
    fileName: z.string().describe("The desired file name for the multimedia component in the CMS (e.g., 'product-image.jpg')."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new component will be created. Use 'search' or 'getItemsInContainer' to find a suitable Folder."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Multimedia Schema to use. If not provided, a default will be determined automatically. Use 'getSchemaLinks' with purpose 'Multimedia' to find available schemas."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields.")
};

const createMultimediaComponentFromUrlSchema = z.object(createMultimediaComponentFromUrlInputProperties);

export const createMultimediaComponentFromUrl = {
    name: "createMultimediaComponentFromUrl",
    description: "Creates a new multimedia component by uploading a file from a public URL. If the parent Folder has a mandatory schema, it will be used automatically, so there is no need to provide a schemaId. This is one of three ways to create a multimedia component, with the others being 'createMultimediaComponentFromBase64' and 'createMultimediaComponentFromPrompt'.",
    input: createMultimediaComponentFromUrlInputProperties,
    async execute(input: z.infer<typeof createMultimediaComponentFromUrlSchema>,
        context: any
    ) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { mediaUrl, title, fileName, locationId, schemaId, metadata } = input;
        
        const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
        const stagedFilePath = path.join(os.tmpdir(), `${crypto.randomUUID()}${path.extname(new URL(mediaUrl).pathname)}`);

        try {
            // --- Part 1: Staging Logic ---
            const requestHeaders = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            };

            console.log(`Checking file size for: ${mediaUrl}`);
            const headResponse = await axios.head(mediaUrl, { 
                timeout: 5000,
                headers: requestHeaders 
            });
            const contentLength = headResponse.headers['content-length'];

            if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
                return {
                   content: [{
                       type: "text",
                       text: `Error: File size of ${contentLength} bytes exceeds the limit of ${MAX_FILE_SIZE_BYTES} bytes.`
                   }],
                };
            }

            console.log(`Fetching media from: ${mediaUrl}`);
            const response = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                maxBodyLength: MAX_FILE_SIZE_BYTES,
                maxContentLength: MAX_FILE_SIZE_BYTES,
                headers: requestHeaders
            });

            fs.writeFileSync(stagedFilePath, response.data);
            console.log(`File successfully downloaded and staged to: ${stagedFilePath}`);

            // --- Part 2: Component Creation Logic ---
            console.log(`Reading file from staged path: ${stagedFilePath}`);
            const fileBuffer = fs.readFileSync(stagedFilePath);
            console.log(`Successfully read file. Size: ${fileBuffer.length} bytes.`);

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
                return {
                    content: [{
                        type: "text",
                        text: `Successfully created multimedia component with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            if (axios.isAxiosError(error) && error.message.includes('maxContentLength')) {
                const sizeErrorContext = `Error: File exceeds the maximum allowed size of ${MAX_FILE_SIZE_BYTES} bytes.`;
                return handleAxiosError(error, sizeErrorContext);
            }
            return handleAxiosError(error, "Failed to create multimedia component from URL");
        } finally {
            // --- Part 3: Cleanup Logic ---
            try {
                if (fs.existsSync(stagedFilePath)) {
                    fs.unlinkSync(stagedFilePath);
                    console.log(`Successfully cleaned up staged file: ${stagedFilePath}`);
                }
            } catch (cleanupError) {
                handleAxiosError(cleanupError, `Failed to clean up staged file ${stagedFilePath}`);
            }
        }
    }
};