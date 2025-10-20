import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import FormData from "form-data";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const updateMultimediaComponentFromPromptInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component to update (e.g., 'tcm:5-123')."),
    prompt: z.string().describe("A descriptive text prompt to guide the image modification (e.g., 'make the car red', 'add a sunny sky')."),
    aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional().describe("The desired aspect ratio for the updated image. Defaults to the original image's aspect ratio.")
};

const updateMultimediaComponentFromPromptSchema = z.object(updateMultimediaComponentFromPromptInputProperties);

export const updateMultimediaComponentFromPrompt = {
    name: "updateMultimediaComponentFromPrompt",
    description: "Updates an existing multimedia component's image based on a text prompt. It downloads the binary, sends it to an AI for modification, and uploads the new version. Versioning is handled automatically. If the item is not checked out, it will be checked out, updated, and then checked back in. If the item is already checked out by you, it will remain checked out after the update. The operation will be aborted if the item is checked out by another user.",
    input: updateMultimediaComponentFromPromptInputProperties,
    async execute(input: z.infer<typeof updateMultimediaComponentFromPromptSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, prompt, aspectRatio } = input;
        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            console.log(`Fetching item details for ${itemId}`);
            const getInitialItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getInitialItemResponse.status !== 200) return handleUnexpectedResponse(getInitialItemResponse);
            
            const itemToUpdate = getInitialItemResponse.data;

            if (itemToUpdate.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }

            console.log(`Downloading binary content for ${itemId}`);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            
            const originalImageBuffer = Buffer.from(downloadResponse.data);
            const originalMimeType = downloadResponse.headers['content-type'] || 'image/jpeg';
            console.log(`Successfully downloaded binary: ${originalImageBuffer.length} bytes, MIME type: ${originalMimeType}`);

            let newImageBase64: string | undefined;

            // --- Gemini API Block ---
            console.log(`Sending image and prompt to Gemini: "${prompt}"`);
            const ai = new GoogleGenAI({ vertexai: false, apiKey: GEMINI_API_KEY });

            const generationConfig: any = {
                responseModalities: ['Image']
            };

            if (aspectRatio) {
                generationConfig.imageConfig = { aspectRatio };
            }

            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-image",
                contents: [
                    { text: prompt },
                    { inlineData: { mimeType: originalMimeType, data: originalImageBuffer.toString('base64') } }
                ],
                config: generationConfig
            });
            
            if (result?.candidates?.[0]?.content?.parts) {
                for (const part of result.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        newImageBase64 = part.inlineData.data;
                        break;
                    }
                }
            }
            console.log("Successfully received updated image from Gemini.");
            // --- End Gemini API Block ---

            if (!newImageBase64) {
                const errorMessage = "AI model did not return an image. This could be due to safety settings or other issues.";
                throw new Error(errorMessage);
            }

            const newImageBuffer = Buffer.from(newImageBase64, 'base64');
            const formData = new FormData();
            formData.append('file', newImageBuffer, itemToUpdate.BinaryContent.Filename);

            console.log("Uploading new binary to CMS temporary storage.");
            const uploadResponse = await authenticatedAxios.post('/binary/upload', formData, {
                headers: formData.getHeaders()
            });
            if (uploadResponse.status !== 202) return handleUnexpectedResponse(uploadResponse);

            const cmsTempFileId = uploadResponse.data.TempFileId;
            console.log(`New binary uploaded. CMS Temporary File ID: ${cmsTempFileId}`);

            itemToUpdate.BinaryContent.UploadFromFile = cmsTempFileId;

            console.log(`Updating component ${itemId} with new binary.`);
            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) return handleUnexpectedResponse(updateResponse);
            
            return {
                content: [{ type: "text", text: `Successfully updated multimedia component ${itemId} based on the prompt.` }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to update multimedia component ${itemId} from prompt`);
        }
    }
};