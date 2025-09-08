import { z } from "zod";
import JSZip from "jszip";
import { Parser as XmlParser } from "xml2js";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

// A more robust helper function to recursively find all text within a parsed XML object.
// It handles both objects and arrays to prevent missing text.
const extractTextFromXmlObject = (obj: any): string[] => {
    let texts: string[] = [];
    if (Array.isArray(obj)) {
        for (const item of obj) {
            texts = texts.concat(extractTextFromXmlObject(item));
        }
    } else if (typeof obj === 'object' && obj !== null) {
        for (const key in obj) {
            if (key === 'a:t') {
                const val = obj[key];
                if (typeof val === 'string' && val.trim() !== '') {
                    texts.push(val);
                } else if (Array.isArray(val)) {
                    texts.push(...val.filter((t: any) => typeof t === 'string' && t.trim() !== ''));
                }
            } else {
                texts = texts.concat(extractTextFromXmlObject(obj[key]));
            }
        }
    }
    return texts;
};

const readPowerPointFileFromMultimediaComponentInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the multimedia component containing the PowerPoint (.pptx) file (e.g., 'tcm:5-126')."),
};

const readPowerPointFileFromMultimediaComponentSchema = z.object(readPowerPointFileFromMultimediaComponentInputProperties);

export const readTextFromPowerPointMultimediaComponent = {
    name: "readPowerPointFileFromMultimediaComponent",
    description: `Reads the text content of a PowerPoint file (.pptx) from a multimedia component and returns it as a string.
    This tool extracts text from all slides.`,
    input: readPowerPointFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readPowerPointFileFromMultimediaComponentSchema>) {
        const { itemId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            // Step 1: Get Item metadata
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) return handleUnexpectedResponse(getItemResponse);
            const itemData = getItemResponse.data;

            if (itemData.ComponentType !== 'Multimedia' || !itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.pptx')) {
                throw new Error(`Item ${itemId} is not a valid .pptx multimedia component.`);
            }

            // Step 2: Download the binary content
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            const pptxFileBuffer = Buffer.from(downloadResponse.data);
            
            // Step 3: Parse the .pptx buffer
            console.log("Parsing .pptx content using JSZip...");
            const zip = await JSZip.loadAsync(pptxFileBuffer);
            const xmlParser = new XmlParser({ explicitArray: false });

            const slideFiles = zip.file(/ppt\/slides\/slide\d+\.xml/);
            if (slideFiles.length === 0) {
                return { content: [{ type: "text", text: "Presentation contains no slides." }] };
            }

            slideFiles.sort((a, b) => {
                const aMatch = a.name.match(/\d+/);
                const bMatch = b.name.match(/\d+/);
                const aNum = aMatch ? parseInt(aMatch[0], 10) : 0;
                const bNum = bMatch ? parseInt(bMatch[0], 10) : 0;
                return aNum - bNum;
            });
            
            // Use Promise.all to parse slides in parallel for better performance
            const allSlidesTextPromises = slideFiles.map(async (slideFile, index) => {
                console.log(`Processing slide ${index + 1}: ${slideFile.name}`);
                const slideXml = await slideFile.async("string");
                const parsedXml = await xmlParser.parseStringPromise(slideXml);
                const slideTexts = extractTextFromXmlObject(parsedXml);
                return `--- Slide ${index + 1} ---\n${slideTexts.join("\n")}`;
            });

            const allSlidesTextArray = await Promise.all(allSlidesTextPromises);
            
            console.log("Parsing complete.");
            return {
                content: [{ type: "text", text: allSlidesTextArray.join("\n\n").trim() }],
            };

        } catch (error) {
            if (error instanceof Error) {
                return handleAxiosError(error, `Failed to read or parse PowerPoint file from multimedia component ${itemId}. Error: ${error.message}`);
            }
            return handleAxiosError(error, `An unknown error occurred while processing component ${itemId}`);
        }
    }
};
