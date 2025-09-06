import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import FormData from "form-data";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const updateMultimediaComponentFromPromptInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component to update (e.g., 'tcm:5-123')."),
    prompt: z.string().describe("A descriptive text prompt to guide the image modification (e.g., 'make the car red', 'add a sunny sky').")
};

const updateMultimediaComponentFromPromptSchema = z.object(updateMultimediaComponentFromPromptInputProperties);

export const updateMultimediaComponentFromPrompt = {
    name: "updateMultimediaComponentFromPrompt",
    description: "Updates an existing multimedia component's image based on a text prompt. It checks out the component, downloads the binary, sends it to an AI for modification, and uploads the new version.",
    input: updateMultimediaComponentFromPromptInputProperties,
    async execute(input: z.infer<typeof updateMultimediaComponentFromPromptSchema>) {
        const { itemId, prompt } = input;
        const restItemId = itemId.replace(':', '_');
        let wasCheckedOutByTool = false;

        try {
            // --- Step 1: Get Item and Perform Check-out ---
            console.log(`Fetching item details for ${itemId}`);
            const getInitialItemResponse = await authenticatedAxios.get(`/items/${restItemId}`, { params: { useDynamicVersion: true } });
            if (getInitialItemResponse.status !== 200) return handleUnexpectedResponse(getInitialItemResponse);
            
            let itemToUpdate = getInitialItemResponse.data;

            if (itemToUpdate.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }

            const whoAmIResponse = await authenticatedAxios.get('/whoAmI');
            if (whoAmIResponse.status !== 200) return handleUnexpectedResponse(whoAmIResponse);
            const agentId = whoAmIResponse.data?.User?.Id;
            if (!agentId) throw new Error("Could not retrieve the current user's ID.");

            const isCheckedOut = itemToUpdate?.LockInfo?.LockType?.includes('CheckedOut');
            const checkedOutUser = itemToUpdate?.VersionInfo?.CheckOutUser?.IdRef;

            if (isCheckedOut && checkedOutUser !== agentId) {
                return { content: [{ type: "text", text: `Operation aborted: Item ${itemId} is checked out by another user (${checkedOutUser}).` }] };
            }

            if (!isCheckedOut) {
                console.log(`Checking out item ${itemId}`);
                const checkOutResponse = await authenticatedAxios.post(`/items/${restItemId}/checkOut`, { "$type": "CheckOutRequest", "SetPermanentLock": true });
                if (checkOutResponse.status !== 200) return handleUnexpectedResponse(checkOutResponse);
                itemToUpdate = checkOutResponse.data;
                wasCheckedOutByTool = true;
            }

            // --- Step 2: Download the original binary content ---
            console.log(`Downloading binary content for ${itemId}`);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            
            const originalImageBuffer = Buffer.from(downloadResponse.data);
            const originalMimeType = downloadResponse.headers['content-type'] || 'image/jpeg';
            console.log(`Successfully downloaded binary: ${originalImageBuffer.length} bytes, MIME type: ${originalMimeType}`);

            // --- Step 3: Pass the image and prompt to Gemini ---
            console.log(`Sending image and prompt to Gemini: "${prompt}"`);
            const ai = new GoogleGenAI({ vertexai: false, apiKey: GEMINI_API_KEY });

            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-image-preview",
                contents: [
                    { text: prompt },
                    { inlineData: { mimeType: originalMimeType, data: originalImageBuffer.toString('base64') } }
                ]
            });
            
            let newImageBase64: string | undefined;
            if (result?.candidates?.[0]?.content?.parts) {
                for (const part of result.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        newImageBase64 = part.inlineData.data;
                        break;
                    }
                }
            }

            if (!newImageBase64) {
                const rejectionReason = result?.promptFeedback?.blockReason;
                const finishReason = result?.candidates?.[0]?.finishReason;
                let errorMessage = "AI model did not return an image.";
                if (rejectionReason) { errorMessage += ` Block Reason: ${rejectionReason}.`; }
                if (finishReason && finishReason !== "STOP") { errorMessage += ` Finish Reason: ${finishReason}.`; }
                throw new Error(errorMessage);
            }
            console.log("Successfully received updated image from Gemini.");

            // --- Step 4: Upload the new binary to CMS ---
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

            // --- Step 5: Update the component to use the new binary ---
            itemToUpdate.BinaryContent.UploadFromFile = cmsTempFileId;

            console.log(`Updating component ${itemId} with new binary.`);
            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) return handleUnexpectedResponse(updateResponse);

            // --- Step 6: Check-in the component ---
            console.log(`Checking in component ${itemId}.`);
            const checkInResponse = await authenticatedAxios.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
            if (checkInResponse.status !== 200) return handleUnexpectedResponse(checkInResponse);
            
            return {
                content: [{ type: "text", text: `Successfully updated multimedia component ${itemId} based on the prompt.` }],
            };

        } catch (error) {
            // --- Cleanup: Undo checkout on failure ---
            if (wasCheckedOutByTool) {
                try {
                    console.log(`An error occurred. Undoing checkout for ${itemId}.`);
                    await authenticatedAxios.post(`/items/${restItemId}/undoCheckOut`);
                } catch (undoError) {
                    console.error(`CRITICAL: Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
                }
            }
            return handleAxiosError(error, `Failed to update multimedia component ${itemId} from prompt`);
        }
    }
};
