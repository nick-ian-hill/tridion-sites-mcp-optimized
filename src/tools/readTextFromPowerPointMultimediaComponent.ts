import { z } from "zod";
import JSZip from "jszip";
import { Parser as XmlParser } from "xml2js";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

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
    name: "readTextFromPowerPointMultimediaComponent",
    description: `Reads the text content of a PowerPoint file (.pptx) from a multimedia component and returns it as a string, organized by slide.
    The extracted text from each slide can then be used to create new content items in the CMS using the 'createComponent' tool.
    For a more advanced function that also extracts images, use 'splitPowerPointMultimediaComponentIntoTextAndImages'.`,
    input: readPowerPointFileFromMultimediaComponentInputProperties,
    async execute(input: z.infer<typeof readPowerPointFileFromMultimediaComponentSchema>, context: any) {
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

            if (itemData.ComponentType !== 'Multimedia' || !itemData.BinaryContent?.Filename?.toLowerCase().endsWith('.pptx')) {
                throw new Error(`Item ${itemId} is not a valid .pptx multimedia component.`);
            }

            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            const pptxFileBuffer = Buffer.from(downloadResponse.data);
            
            console.log("Parsing .pptx content using JSZip...");
            const zip = await JSZip.loadAsync(pptxFileBuffer);
            const xmlParser = new XmlParser({ explicitArray: false });

            const slideFiles = zip.file(/ppt\/slides\/slide\d+\.xml/);
            if (slideFiles.length === 0) {
                const errorResponse = {
                    $type: 'PowerPointText',
                    Id: itemId,
                    Content: "Presentation contains no slides.",
                };
                return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }] };
            }

            slideFiles.sort((a, b) => {
                const aMatch = a.name.match(/\d+/);
                const bMatch = b.name.match(/\d+/);
                const aNum = aMatch ? parseInt(aMatch[0], 10) : 0;
                const bNum = bMatch ? parseInt(bMatch[0], 10) : 0;
                return aNum - bNum;
            });
            
            const allSlidesData = await Promise.all(slideFiles.map(async (slideFile, index) => {
                console.log(`Processing slide ${index + 1}: ${slideFile.name}`);
                const slideXml = await slideFile.async("string");
                const parsedXml = await xmlParser.parseStringPromise(slideXml);
                const slideTexts = extractTextFromXmlObject(parsedXml);
                return {
                    SlideNumber: index + 1,
                    Content: slideTexts.join("\n")
                };
            }));
            
            console.log("Parsing complete.");
            
            const fullTextContent = allSlidesData
                .map(s => `--- Slide ${s.SlideNumber} ---\n${s.Content}`)
                .join("\n\n");

            const responseData = {
                $type: "PowerPointText",
                Id: itemId,
                Content: fullTextContent.trim(),
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            if (error instanceof Error) {
                return handleAxiosError(error, `Failed to read or parse PowerPoint file from multimedia component ${itemId}. Error: ${error.message}`);
            }
            return handleAxiosError(error, `An unknown error occurred while processing component ${itemId}`);
        }
    }
};