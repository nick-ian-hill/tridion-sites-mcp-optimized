import { z } from "zod";
import mammoth from "mammoth";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

const readPowerPointFileFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the PowerPoint (.pptx) file (e.g., 'tcm:5-126')."),
};

const readPowerPointFileFromMultimediaComponentSchema = z.object(readPowerPointFileFromMultimediaComponentInputProperties);

export const readPowerPointFileFromMultimediaComponent = {
    name: "readPowerPointFileFromMultimediaComponent",
    description: `Reads the text content of a PowerPoint file (.pptx) from a multimedia component and returns it as a string.
    This tool extracts text from all slides and notes.`,
    input: readPowerPointFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readPowerPointFileFromMultimediaComponentSchema>) {
        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            // --- Step 1: Get Item metadata to verify type and filename ---
            console.log(`Fetching item details for ${itemId} to verify it's a PowerPoint file.`);
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);

            const itemData = getItemResponse.data;

            if (itemData.ComponentType !== 'Multimedia') {
                throw new Error(`Item ${itemId} is not a Multimedia Component.`);
            }
            if (!itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.pptx')) {
                 throw new Error(`The file in component ${itemId} is not a .pptx file. Filename: ${itemData.BinaryContent?.Filename}`);
            }

            // --- Step 2: Download the binary content ---
            console.log(`Downloading binary content for PowerPoint file: ${itemData.BinaryContent.Filename}`);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);

            const pptxFileBuffer = Buffer.from(downloadResponse.data);
            console.log(`Successfully downloaded ${pptxFileBuffer.length} bytes.`);

            // --- Step 3: Parse the .pptx buffer into text using mammoth ---
            console.log("Parsing .pptx content into text...");
            const { value: textContent } = await mammoth.extractRawText({ buffer: pptxFileBuffer });
            console.log("Parsing complete.");

            return {
                content: [{ type: "text", text: textContent }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to read PowerPoint file from multimedia component ${itemId}`);
        }
    }
};
