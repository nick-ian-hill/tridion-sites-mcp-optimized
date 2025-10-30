import { z } from "zod";
import mammoth from "mammoth";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { createMultimediaComponentFromBase64 } from "./createMultimediaComponentFromBase64.js";

const splitWordMultimediaComponentIntoTextAndImagesInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+$/).describe("The TCM URI of the source Word multimedia component."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new image components will be created."),
};

const splitWordMultimediaComponentIntoTextAndImagesSchema = z.object(splitWordMultimediaComponentIntoTextAndImagesInputProperties);

export const splitWordMultimediaComponentIntoTextAndImages = {
    name: "splitWordMultimediaComponentIntoTextAndImages",
    description: "Splits a Word multimedia component into its text and images. It returns the text as HTML and creates new multimedia components for each image.",
    input: splitWordMultimediaComponentIntoTextAndImagesInputProperties,
    async execute(input: z.infer<typeof splitWordMultimediaComponentIntoTextAndImagesSchema>, context: any) {
        const { itemId, locationId } = input;
        const restItemId = itemId.replace(':', '_');

        try {
            const authenticatedAxios = createAuthenticatedAxios(context?.request?.headers?.cookie.match(/UserSessionID=([^;]+)/)?.[1]);
            const downloadResponse = await authenticatedAxios.get(`/items/${restItemId}/binary/download`, {
                responseType: 'arraybuffer'
            });
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);
            const wordFileBuffer = Buffer.from(downloadResponse.data);

            const images: {
                placeholderSrc: string;
                base64: string;
                contentType: string;
                newId?: string;
            }[] = [];
            let imageCounter = 0;

            const mammothOptions = {
                convertImage: mammoth.images.imgElement(async (image) => {
                    const base64 = await image.read("base64");
                    const placeholderSrc = `image-${++imageCounter}.${image.contentType.split('/')[1]}`;
                    images.push({ placeholderSrc, base64, contentType: image.contentType });
                    return { src: placeholderSrc };
                })
            };

            let { value: htmlContent } = await mammoth.convertToHtml({ buffer: wordFileBuffer }, mammothOptions);
            
            let createdImageComponents: any[] = [];

            if (images.length > 0) {
                const createdImagePromises = images.map(async (img) => {
                    const title = img.placeholderSrc.substring(0, img.placeholderSrc.lastIndexOf('.'));
                    const result = await createMultimediaComponentFromBase64.execute({
                        base64Content: img.base64,
                        title: title,
                        fileName: img.placeholderSrc,
                        locationId: locationId,
                    }, context);
                    
                    const resultText = result.content[0].text || "";
                    let newId = 'FailedToCreate';
                    
                    try {
                        const jsonResult = JSON.parse(resultText);
                        newId = jsonResult.Id || 'FailedToParseId';
                    } catch (e) {
                        const newIdMatch = resultText.match(/tcm:\d+-\d+/);
                         if (newIdMatch) newId = newIdMatch[0];
                    }
                    
                    img.newId = newId;
                    return {
                        OriginalName: img.placeholderSrc,
                        ComponentId: newId
                    };
                });
                
                createdImageComponents = await Promise.all(createdImagePromises);

                images.forEach(img => {
                    if (img.newId && img.newId.startsWith('tcm:')) {
                        // Replace placeholder src with a valid CMS link structure for XHTML fields
                        htmlContent = htmlContent.replace(
                            `src="${img.placeholderSrc}"`, 
                            `src="${img.newId}" xlink:href="${img.newId}" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:title=""`
                        );
                    }
                });
            }
            
            const responseData = {
                $type: "SplitWordDocResult",
                Id: itemId,
                CreatedImageComponents: createdImageComponents,
                HtmlContent: htmlContent
            };

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(responseData, null, 2)
                }]
            };
        } catch (error) {
            return handleAxiosError(error, `Failed to split Word component ${itemId}`);
        }
    }
};