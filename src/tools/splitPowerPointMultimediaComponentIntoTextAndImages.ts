import { z } from "zod";
import JSZip from "jszip";
import { Parser as XmlParser } from "xml2js";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { createMultimediaComponentFromBase64 } from "./createMultimediaComponentFromBase64.js";

// Helper function to extract text from parsed XML
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

const splitPowerPointMultimediaComponentIntoTextAndImagesInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the source PowerPoint multimedia component."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new image components will be created."),
};

const splitPowerPointMultimediaComponentIntoTextAndImagesSchema = z.object(splitPowerPointMultimediaComponentIntoTextAndImagesInputProperties);

export const splitPowerPointMultimediaComponentIntoTextAndImages = {
    name: "splitPowerPointMultimediaComponentIntoTextAndImages",
    description: "Splits a PowerPoint multimedia component into its constituent parts. It extracts all text and creates new multimedia components for each image, returning a consolidated text summary of the results.",
    input: splitPowerPointMultimediaComponentIntoTextAndImagesInputProperties,
    async execute(input: z.infer<typeof splitPowerPointMultimediaComponentIntoTextAndImagesSchema>) {
        const { itemId, locationId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            // Step 1: Download the .pptx file
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            const pptxFileBuffer = Buffer.from(downloadResponse.data);
            
            // Step 2: Initialize parsers
            const zip = await JSZip.loadAsync(pptxFileBuffer);
            const xmlParser = new XmlParser({ explicitArray: false });

            // Step 3: Process text and images in parallel
            
            const textPromise = (async () => {
                const slideFiles = zip.file(/ppt\/slides\/slide\d+\.xml/);
                slideFiles.sort((a, b) => {
                    const aNum = parseInt(a.name.match(/\d+/)?.[0] || '0', 10);
                    const bNum = parseInt(b.name.match(/\d+/)?.[0] || '0', 10);
                    return aNum - bNum;
                });
                const slideTextPromises = slideFiles.map(async (file, i) => {
                    const xml = await file.async("string");
                    const parsed = await xmlParser.parseStringPromise(xml);
                    return `--- Slide ${i + 1} ---\n${extractTextFromXmlObject(parsed).join("\n")}`;
                });
                return (await Promise.all(slideTextPromises)).join("\n\n");
            })();

            const imagesPromise = (async () => {
                const imageFiles = zip.file(/ppt\/media\/.+\.(png|jpeg|jpg|gif|svg)/i);
                const createdImages: { originalFileName: string; newComponentId: string }[] = [];

                for (const imageFile of imageFiles) {
                    const base64Content = await imageFile.async("base64");
                    const fileName = imageFile.name.split('/').pop() || 'image.png';
                    const title = fileName.substring(0, fileName.lastIndexOf('.'));

                    const result = await createMultimediaComponentFromBase64.execute({
                        base64Content,
                        title,
                        fileName,
                        locationId,
                    });
                    
                    const resultText = result.content[0].text || "";
                    const newIdMatch = resultText.match(/tcm:\d+-\d+/);
                    if (newIdMatch) {
                        createdImages.push({
                            originalFileName: fileName,
                            newComponentId: newIdMatch[0],
                        });
                    }
                }
                return createdImages;
            })();

            // Await both promises
            const [textContent, extractedImages] = await Promise.all([textPromise, imagesPromise]);

            // Step 4: Format the results into a single text string for the agent
            let formattedResponseText = `Successfully split the PowerPoint component ${itemId}.\n\n`;

            if (extractedImages.length > 0) {
                formattedResponseText += `### Extracted Images\n`;
                extractedImages.forEach(img => {
                    formattedResponseText += `* Original Name: ${img.originalFileName}, Created Component: ${img.newComponentId}\n`;
                });
                formattedResponseText += `\n`;
            } else {
                formattedResponseText += `No images were found to extract.\n\n`;
            }

            if (textContent) {
                formattedResponseText += `### Extracted Text\n${textContent}`;
            }

            return {
                content: [{
                    type: "text",
                    text: formattedResponseText.trim()
                }]
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to split PowerPoint component ${itemId}`);
        }
    }
};
