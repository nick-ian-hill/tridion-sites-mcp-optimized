import { z } from "zod";
import mammoth from "mammoth";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const readTextFromWordMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the Word (.docx) file (e.g., 'tcm:5-123')."),
};

const readTextFromWordMultimediaComponentSchema = z.object(readTextFromWordMultimediaComponentInputProperties);

export const readTextFromWordMultimediaComponent = {
    name: "readTextFromWordMultimediaComponent",
    description: "Reads the text content of a Word file (.docx) from a multimedia component and returns it as an HTML string, excluding any images.",
    input: readTextFromWordMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readTextFromWordMultimediaComponentSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            
            const itemData = getItemResponse.data;
            if (itemData.ComponentType !== 'Multimedia' || !itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.docx')) {
                 throw new Error(`Item ${itemId} is not a valid .docx multimedia component.`);
            }

            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            
            const wordFileBuffer = Buffer.from(downloadResponse.data);

            const mammothOptions = {
                convertImage: async function(_image: any) {
                    return [];
                }
            } as any; 

            const { value: htmlContent } = await mammoth.convertToHtml({ buffer: wordFileBuffer }, mammothOptions);

            return {
                content: [{ type: "text", text: htmlContent }],
            };
        } catch (error) {
            return handleAxiosError(error, `Failed to read text from Word file in multimedia component ${itemId}`);
        }
    }
};