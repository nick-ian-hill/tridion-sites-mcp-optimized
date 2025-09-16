import { z } from "zod";
import mammoth from "mammoth";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const readWordFileFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the Word (.docx) file (e.g., 'tcm:5-123')."),
};

const readWordFileFromMultimediaComponentSchema = z.object(readWordFileFromMultimediaComponentInputProperties);

export const readWordFileFromMultimediaComponent = {
    name: "readWordFileFromMultimediaComponent",
    description: `Reads the content of a Word file (.docx) from a multimedia component and returns it as an HTML string.
    This tool can be useful in cases where the user would like to import the contents of a Word file into the CMS.`,
    input: readWordFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readWordFileFromMultimediaComponentSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            console.log(`Fetching item details for ${itemId} to verify it's a Word file.`);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            
            const itemData = getItemResponse.data;

            if (itemData.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }
            if (!itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.docx')) {
                 throw new Error(`The file in component ${itemId} is not a .docx file. Filename: ${itemData.BinaryContent?.Filename}`);
            }

            console.log(`Downloading binary content for Word file: ${itemData.BinaryContent.Filename}`);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            
            const wordFileBuffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded ${wordFileBuffer.length} bytes.`);

            console.log("Parsing .docx content into HTML...");
            const { value: htmlContent } = await mammoth.convertToHtml({ buffer: wordFileBuffer });
            console.log("Parsing complete.");

            return {
                content: [{ type: "text", text: htmlContent }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read Word file from multimedia component ${itemId}`);
        }
    }
};