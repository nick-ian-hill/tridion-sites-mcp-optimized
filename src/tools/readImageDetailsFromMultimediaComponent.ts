import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { getImageMimeType, analyzeImageBuffer } from "../utils/fileProcessing.js";

const readImageDetailsFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the image file (e.g., 'tcm:5-123'). Use 'search' or 'getItemsInContainer' to find it."),
    prompt: z.string().describe("The text prompt for the vision model. For example: 'Describe the image in detail.', 'What text is visible in this image?', 'Is there a cat in this picture?'"),
};

const readImageDetailsFromMultimediaComponentSchema = z.object(readImageDetailsFromMultimediaComponentInputProperties);

const getMimeType = getImageMimeType;

export const readImageDetailsFromMultimediaComponent = {
    name: "readImageDetailsFromMultimediaComponent",
    description: `Analyzes an image from a multimedia component using a generative AI vision model based on a provided text prompt. 
    It can be used to describe images, extract text (OCR), identify objects, generate alt text, and answer questions about the visual content.
    Note: If you need to read or analyse a file directly attached/uploaded by the user, use 'readUploadedFile' instead.`,
    input: readImageDetailsFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readImageDetailsFromMultimediaComponentSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, prompt } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            console.log(`Fetching item details for ${itemId} to verify it's an image.`);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }

            const itemData = getItemResponse.data;
            if (itemData.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }

            const filename = itemData.BinaryContent?.Filename;
            if (!filename) {
                throw new Error(`Component ${itemId} does not have a filename.`);
            }

            const mimeType = getMimeType(filename);
            if (!mimeType) {
                throw new Error(`Unsupported image type for file: ${filename}. Supported types: png, jpg, jpeg, webp, gif.`);
            }
            console.log(`Identified file '${filename}' with MIME type '${mimeType}'.`);

            console.log(`Downloading binary content for image: ${filename}`);
            const downloadResponse = await authenticatedAxios.get<ArrayBuffer>(
                `/items/${restItemId}/binary/download`, 
                { responseType: 'arraybuffer' }
            );

            if (downloadResponse.status !== 200) {
                return handleUnexpectedResponse(downloadResponse);
            }
            
            const imageBuffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded and encoded ${imageBuffer.length} bytes.`);
            
            console.log(`Sending prompt and image to Image model...`);
            const text = await analyzeImageBuffer(imageBuffer, mimeType, prompt);
            
            const responseData = {
                type: "ImageAnalysis",
                Id: itemId,
                Description: text
            };

            console.log("Successfully received response from Gemini.");

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read image details from multimedia component ${itemId}`);
        }
    }
};