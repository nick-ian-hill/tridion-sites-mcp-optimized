import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import FormData from "form-data";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const updateMultimediaComponentFromPromptInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component to update (e.g., 'tcm:5-123')."),
    prompt: z.string().describe("A descriptive text prompt to guide the image modification (e.g., 'make the car red', 'add a sunny sky'). If 'contextItemIds' are provided, the prompt should explain how the user wishes the context item(s) to be used (e.g., 'Use the first image for the character's pose and the second for the color palette')."),
    aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional().describe("The desired aspect ratio for the updated image. Defaults to the original image's aspect ratio."),
    contextItemIds: z.array(z.string().regex(/^tcm:\d+-\d+$/)).optional().describe("An optional array of TCM URIs for other multimedia components to use as context (e.g., for style reference, composition, or combining elements).")
};

const updateMultimediaComponentFromPromptSchema = z.object(updateMultimediaComponentFromPromptInputProperties);

export const updateMultimediaComponentFromPrompt = {
    name: "updateMultimediaComponentFromPrompt",
    description: "Updates an existing multimedia component's image based on a text prompt. It downloads the binary, sends it to an AI for modification (optionally using other images as context), and uploads the new version. Versioning is handled automatically. If contextItemIds is not empty, be sure to explain in the prompt how the model should utilize the context item(s).",
    input: updateMultimediaComponentFromPromptInputProperties,
    async execute(input: z.infer<typeof updateMultimediaComponentFromPromptSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, prompt, aspectRatio, contextItemIds } = input;
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
            if (!GEMINI_API_KEY) {
                return handleAxiosError(new Error("GEMINI_API_KEY environment variable is not set."), "Configuration Error");
            }

            // Initialize content array with the prompt and the item being updated
            // We use a flat array structure (Part[]) which is supported by the SDK helper
            const contents: any[] = [
                { text: prompt },
                { inlineData: { mimeType: originalMimeType, data: originalImageBuffer.toString('base64') } }
            ];

            // If context items are provided, fetch their binaries and add them to the payload
            if (contextItemIds && contextItemIds.length > 0) {
                console.log(`Fetching ${contextItemIds.length} context items...`);
                
                for (const contextId of contextItemIds) {
                    // Skip if the context item is the same as the target item to avoid duplication
                    if (contextId === itemId) continue;

                    const restContextId = contextId.replace(':', '_');
                    
                    // 1. Verify item type
                    const itemResponse = await authenticatedAxios.get(`/items/${restContextId}`);
                    if (itemResponse.status !== 200) {
                        console.warn(`Could not fetch context item ${contextId}. Skipping.`);
                        continue;
                    }
                    if (itemResponse.data.ComponentType !== 'Multimedia') {
                        console.warn(`Context item ${contextId} is not a Multimedia Component. Skipping.`);
                        continue;
                    }

                    // 2. Download binary
                    console.log(`Downloading binary for context item ${contextId}...`);
                    const downloadCtxResponse = await authenticatedAxios.get(`/items/${restContextId}/binary/download`, {
                        responseType: 'arraybuffer'
                    });

                    if (downloadCtxResponse.status === 200) {
                        const buffer = Buffer.from(downloadCtxResponse.data);
                        const mimeType = downloadCtxResponse.headers['content-type'] || 'image/jpeg';
                        
                        contents.push({
                            inlineData: {
                                mimeType: mimeType,
                                data: buffer.toString('base64')
                            }
                        });
                    } else {
                        console.warn(`Failed to download binary for ${contextId}. Status: ${downloadCtxResponse.status}`);
                    }
                }
            }

            console.log(`Sending image and prompt to Gemini: "${prompt}" with ${contents.length - 2} additional context images.`);
            const ai = new GoogleGenAI({ vertexai: false, apiKey: GEMINI_API_KEY });

            const generationConfig: any = {
                responseModalities: ['IMAGE']
            };

            if (aspectRatio) {
                generationConfig.imageConfig = { aspectRatio };
            }

            const result = await ai.models.generateContent({
                model: "gemini-3.1-flash-image-preview",
                contents: contents,
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
            return handleAxiosError(error, `Failed to update multimedia component ${itemId} from prompt`);
        }
    }
};