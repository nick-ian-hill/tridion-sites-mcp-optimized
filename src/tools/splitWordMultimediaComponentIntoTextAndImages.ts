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
            let summary = `Successfully split Word component ${itemId}.\n\n`;

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
                    const newIdMatch = resultText.match(/tcm:\d+-\d+/);
                    if (newIdMatch) {
                        img.newId = newIdMatch[0];
                    }
                });
                await Promise.all(createdImagePromises);

                summary += '### Created Image Components\n';
                images.forEach(img => {
                    summary += `* Original: ${img.placeholderSrc}, Created Component: ${img.newId || 'Failed to create'}\n`;
                    if (img.newId) {
                        htmlContent = htmlContent.replace(`src="${img.placeholderSrc}"`, `src="${img.newId}" xlink:href="${img.newId}" xmlns:xlink="http://www.w3.org/1999/xlink"`);
                    }
                });
            } else {
                summary += 'No images were found in the document.\n';
            }
            
            summary += `\n### Extracted HTML Content\n${htmlContent}`;

            return {
                content: [{
                    type: "text",
                    text: summary
                }]
            };
        } catch (error) {
            return handleAxiosError(error, `Failed to split Word component ${itemId}`);
        }
    }
};