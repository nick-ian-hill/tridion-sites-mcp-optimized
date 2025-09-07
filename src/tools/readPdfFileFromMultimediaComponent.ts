import { z } from "zod";
import { PdfReader } from "pdfreader";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const readPdfFileFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the PDF (.pdf) file (e.g., 'tcm:5-125')."),
};

const readPdfFileFromMultimediaComponentSchema = z.object(readPdfFileFromMultimediaComponentInputProperties);

export const readPdfFileFromMultimediaComponent = {
    name: "readPdfFileFromMultimediaComponent",
    description: `Reads the text content of a PDF file (.pdf) from a multimedia component and returns it as a string.
    This tool can be useful in cases where the user would like to import the contents of a PDF file into the CMS.`,
    input: readPdfFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readPdfFileFromMultimediaComponentSchema>) {
        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            // --- Step 1: Get Item metadata to verify type and filename ---
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

            // --- Step 2: Download the binary content ---
            console.log(`Downloading binary content for PDF file: ${itemData.BinaryContent.Filename}`);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);

            const pdfFileBuffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded ${pdfFileBuffer.length} bytes.`);

            // --- Step 3: Parse the .pdf buffer into text using pdfreader ---
            console.log("Parsing .pdf content into text using pdfreader...");
            const textContent = await new Promise<string>((resolve, reject) => {
                let content = "";
                new PdfReader(null).parseBuffer(pdfFileBuffer, (err, item) => {
                    if (err) {
                        reject(err);
                    } else if (!item) {
                        // End of file
                        resolve(content);
                    } else if (item.text) {
                        // Append text item, ensuring a space for readability
                        content += item.text + " ";
                    }
                });
            });
            console.log("Parsing complete.");

            return {
                content: [{ type: "text", text: textContent.trim() }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read PDF file from multimedia component ${itemId}`);
        }
    }
};
