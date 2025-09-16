import { z } from "zod";
import JSZip from "jszip";
import { Parser as XmlParser } from "xml2js";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";
import { createMultimediaComponentFromBase64 } from "./createMultimediaComponentFromBase64.js";

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

const findAttributeValues = (obj: any, attributeName: string): string[] => {
    let values: string[] = [];
    if (!obj || typeof obj !== 'object') {
        return values;
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            values = values.concat(findAttributeValues(item, attributeName));
        }
    } else {
        if (obj['$'] && obj['$'][attributeName]) {
            values.push(obj['$'][attributeName]);
        }
        for (const key in obj) {
            if (key !== '$') {
                values = values.concat(findAttributeValues(obj[key], attributeName));
            }
        }
    }
    return [...new Set(values)];
};


const splitPowerPointMultimediaComponentIntoTextAndImagesInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the source PowerPoint multimedia component."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new image components will be created."),
};

const splitPowerPointMultimediaComponentIntoTextAndImagesSchema = z.object(splitPowerPointMultimediaComponentIntoTextAndImagesInputProperties);

interface Relationship {
  $: {
    Id: string;
    Type: string;
    Target: string;
  };
}

export const splitPowerPointMultimediaComponentIntoTextAndImages = {
    name: "splitPowerPointMultimediaComponentIntoTextAndImages",
    description: "Splits a PowerPoint multimedia component into its constituent parts. It extracts all text and creates new multimedia components for each image, returning a consolidated text summary of the results with image-to-slide mappings.",
    input: splitPowerPointMultimediaComponentIntoTextAndImagesInputProperties,
    async execute(input: z.infer<typeof splitPowerPointMultimediaComponentIntoTextAndImagesSchema>, context: any) {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, locationId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            const pptxFileBuffer = Buffer.from(downloadResponse.data);
            
            const zip = await JSZip.loadAsync(pptxFileBuffer);
            const xmlParser = new XmlParser({ explicitArray: false, attrkey: '$' });

            const slideFiles = zip.file(/ppt\/slides\/slide\d+\.xml/).sort((a, b) => {
                const aNum = parseInt(a.name.match(/\d+/)?.[0] || '0', 10);
                const bNum = parseInt(b.name.match(/\d+/)?.[0] || '0', 10);
                return aNum - bNum;
            });

            const slideDataPromises = slideFiles.map(async (slideFile) => {
                const slideNumber = parseInt(slideFile.name.match(/\d+/)?.[0] || '0', 10);
                
                const slideXml = await slideFile.async("string");
                const parsedSlide = await xmlParser.parseStringPromise(slideXml);
                const textContent = extractTextFromXmlObject(parsedSlide).join("\n");

                const relsFilePath = `ppt/slides/_rels/${slideFile.name.split('/').pop()}.rels`;
                const relsFile = zip.file(relsFilePath);
                let imagePaths: string[] = [];

                if (relsFile) {
                    const relsXml = await relsFile.async("string");
                    const parsedRels = await xmlParser.parseStringPromise(relsXml);
                    
                    const relsDataSource = parsedRels.Relationships.Relationship;
                    const relationships = (Array.isArray(relsDataSource)
                        ? relsDataSource
                        : relsDataSource ? [relsDataSource] : []) as Relationship[];

                    const imageRelsMap = relationships
                        .filter((r: Relationship) => r?.$?.Type.endsWith('/image'))
                        .reduce((acc, r: Relationship) => {
                            if (r.$.Id && r.$.Target) {
                                acc[r.$.Id] = r.$.Target;
                            }
                            return acc;
                        }, {} as { [key: string]: string });

                    const embedIds = findAttributeValues(parsedSlide, 'r:embed');
                    embedIds.forEach(rId => {
                        if (imageRelsMap[rId]) {
                            const resolvedPath = `ppt/media/${imageRelsMap[rId].split('/').pop()}`;
                            imagePaths.push(resolvedPath);
                        }
                    });
                }
                return { slideNumber, textContent, imagePaths };
            });

            const allSlidesData = await Promise.all(slideDataPromises);
            
            const uniqueImagePaths = [...new Set(allSlidesData.flatMap(s => s.imagePaths))];
            const imagePathToComponentIdMap = new Map<string, string>();

            if (uniqueImagePaths.length > 0) {
                 const createdImagesPromises = uniqueImagePaths.map(async (imagePath) => {
                    const imageFile = zip.file(imagePath);
                    if (!imageFile) return null;

                    const base64Content = await imageFile.async("base64");
                    const fileName = imageFile.name.split('/').pop() || 'image.png';
                    const title = fileName.substring(0, fileName.lastIndexOf('.'));

                    const result = await createMultimediaComponentFromBase64.execute({
                        base64Content, title, fileName, locationId,
                    }, context);

                    const resultText = result.content[0].text || "";
                    const newIdMatch = resultText.match(/tcm:\d+-\d+/);
                    if (newIdMatch) {
                        return { imagePath, newComponentId: newIdMatch[0] };
                    }
                    return null;
                });
                
                const createdImages = (await Promise.all(createdImagesPromises)).filter(Boolean) as { imagePath: string; newComponentId: string; }[];
                createdImages.forEach(img => imagePathToComponentIdMap.set(img.imagePath, img.newComponentId));
            }
           
            let formattedResponseText = `Successfully split the PowerPoint component ${itemId}.\n`;

            if (allSlidesData.length === 0) {
                 formattedResponseText += `No slides were found in the presentation.`;
            } else {
                 allSlidesData.forEach(slide => {
                    formattedResponseText += `\n### Slide ${slide.slideNumber}\n`;
                    if (slide.textContent.trim()) {
                        formattedResponseText += `**Text:**\n${slide.textContent.trim()}\n`;
                    } else {
                        formattedResponseText += `No text content found on this slide.\n`;
                    }

                    if (slide.imagePaths.length > 0) {
                        formattedResponseText += `**Images:**\n`;
                        slide.imagePaths.forEach(path => {
                            const componentId = imagePathToComponentIdMap.get(path);
                            const originalName = path.split('/').pop();
                            formattedResponseText += `* Original Name: ${originalName}, Created Component: ${componentId || 'N/A'}\n`;
                        });
                    }
                });
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