import { z } from "zod";
import { PdfReader } from "pdfreader";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

const readPdfFileFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the PDF (.pdf) file (e.g., 'tcm:5-125'). Use 'search' or 'getItemsInContainer' to find it."),
};

const readPdfFileFromMultimediaComponentSchema = z.object(readPdfFileFromMultimediaComponentInputProperties);

export const readPdfFileFromMultimediaComponent = {
    name: "readPdfFileFromMultimediaComponent",
    description: `Reads the text content of a PDF file (.pdf) from a multimedia component and returns it as a string.
    This tool can be useful in cases where the user would like to import the contents of a PDF file into the CMS.
    The extracted text can be used as the value for a content field in a call to 'createComponent' or 'updateContent'.`,
    input: readPdfFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readPdfFileFromMultimediaComponentSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);

            console.log(`Fetching item details for ${itemId} to verify it's a PDF file.`);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);

            const itemData = getItemResponse.data;

            if (itemData.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }
            if (!itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.pdf')) {
                 throw new Error(`The file in component ${itemId} is not a .pdf file. Filename: ${itemData.BinaryContent?.Filename}`);
            }

            console.log(`Downloading binary content for PDF file: ${itemData.BinaryContent.Filename}`);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);

            const pdfFileBuffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded ${pdfFileBuffer.length} bytes.`);

            console.log("Parsing .pdf content into text using pdfreader...");
            const textContent = await new Promise<string>((resolve, reject) => {
                let content = "";
                new PdfReader(null).parseBuffer(pdfFileBuffer, (err, item) => {
                    if (err) {
                        reject(err);
                    } else if (!item) {
                        resolve(content);
                    } else if (item.text) {
                        content += item.text + " ";
                    }
                });
            });
            console.log("Parsing complete.");

            const responseData = {
                $type: "PdfText",
                Id: itemId,
                Content: textContent.trim()
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read PDF file from multimedia component ${itemId}`);
        }
    }
};