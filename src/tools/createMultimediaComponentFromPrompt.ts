import { z } from "zod";
import { createMultimediaComponentFromBase64 } from "./createMultimediaComponentFromBase64.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { handleAxiosError } from "../utils/errorUtils.js";
import { GoogleGenAI } from "@google/genai";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { formatForApi } from "../utils/fieldReordering.js";
import { getImageMimeType } from "../utils/fileProcessing.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const createMultimediaComponentFromPromptInputProperties = {
    prompt: z.string().describe("Instructions to guide the image generation model. Include both the subject description (what to draw) and explicit commands on how to use any provided 'contextItemIds' or 'contextAttachments' (e.g., 'Use the first image for the character's pose and the second for the color palette.' or 'Use a similar style to the context images.')."),
    title: z.string().describe("The title for the new multimedia component."),
    fileName: z.string().describe("The desired file name with a valid image extension (e.g., 'banner-v1.jpg' or 'icon.png'). Ensure the extension matches the expected output format."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new component will be created. Use 'search' or 'getItemsInContainer' to find a suitable Folder."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Multimedia Schema to use. If not provided, a default will be determined automatically. Use 'getSchemaLinks' with purpose 'Multimedia' to find available schemas."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields."),
    aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional().describe("The desired aspect ratio for the generated image. Defaults to 1:1 square if not specified."),
    contextItemIds: z.array(z.string().regex(/^tcm:\d+-\d+$/)).optional().describe("An optional array of TCM URIs for existing CMS multimedia components to use as context (e.g., for style reference, composition, or combining elements)."),
    contextAttachments: z.array(z.object({
        attachmentId: z.string().describe("The attachment ID of the uploaded file provided in the context."),
        fileName: z.string().describe("The original file name including extension (e.g., 'sketch.png')."),
    })).optional().describe("An optional array of user-attached image files to use as context. Use these instead of 'contextItemIds' when the reference images were uploaded by the user as attachments rather than stored as CMS multimedia components.")
};

const createMultimediaComponentFromPromptSchema = z.object(createMultimediaComponentFromPromptInputProperties);

export const createMultimediaComponentFromPrompt = {
    name: "createMultimediaComponentFromPrompt",
    description: `Generates an image from a text prompt using the Gemini API and creates a new multimedia component from it. Can optionally use existing CMS multimedia components ('contextItemIds') or user-attached images ('contextAttachments') as context for style references, composition, or combining elements. Be sure to explain in the prompt how any reference images should be used. This is one of four ways to create a multimedia component, with the others being 'createMultimediaComponentFromBase64', 'createMultimediaComponentFromUrl', and 'createMultimediaComponentFromAttachment' (for user-attached files).

Example: Style Transfer using a CMS image
// Use an existing "Brand Style" image (tcm:5-88) as a reference to generate a new banner image.
const result = await tools.createMultimediaComponentFromPrompt({
    prompt: "A modern, collaborative workspace with a diverse team brainstorming around a whiteboard. High energy, professional atmosphere. Use the provided image as a reference.",
    title: "Team Collaboration Banner",
    fileName: "team-collab-banner.jpg",
    locationId: "tcm:5-10-2",
    aspectRatio: "16:9",
    contextItemIds: ["tcm:5-88"]
});

Example: Style Transfer using a user-attached image
// Use a sketch the user has attached as a style reference.
const result = await tools.createMultimediaComponentFromPrompt({
    prompt: "Generate a polished product banner in the same style and colour palette as the attached sketch.",
    title: "Product Banner",
    fileName: "product-banner.jpg",
    locationId: "tcm:5-10-2",
    aspectRatio: "16:9",
    contextAttachments: [{ attachmentId: "abc-123", fileName: "sketch.png" }]
});

Expected JSON Output:
{
  "type": "MultimediaComponent",
  "Id": "tcm:5-2024",
  "Message": "Successfully created tcm:5-2024"
}`,
    input: createMultimediaComponentFromPromptInputProperties,
    async execute(input: z.infer<typeof createMultimediaComponentFromPromptSchema>,
        context: any
    ) {
        formatForApi(input);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { prompt, title, fileName, locationId, schemaId, metadata, aspectRatio, contextItemIds, contextAttachments } = input;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            
            // Build the contents array
            const contents: any[] = [{ text: prompt }];

            // If context items are provided, fetch their binaries and add them to the payload
            if (contextItemIds && contextItemIds.length > 0) {
                console.log(`Fetching ${contextItemIds.length} context items...`);
                
                for (const contextId of contextItemIds) {
                    const restContextId = contextId.replace(':', '_');
                    
                    // 1. Verify item type
                    const itemResponse = await authenticatedAxios.get(`/items/${restContextId}`);
                    if (itemResponse.status !== 200) {
                        console.warn(`Could not fetch context item ${contextId}. Skipping.`);
                        continue;
                    }
                    if (itemResponse.data.ComponentType !== 'Multimedia') {
                        console.warn(`Context item ${contextId} is not a Multimedia Component. Skipping.`);
                        continue;
                    }

                    // 2. Download binary
                    console.log(`Downloading binary for context item ${contextId}...`);
                    const downloadResponse = await authenticatedAxios.get(`/items/${restContextId}/binary/download`, {
                        responseType: 'arraybuffer'
                    });

                    if (downloadResponse.status === 200) {
                        const buffer = Buffer.from(downloadResponse.data);
                        const mimeType = downloadResponse.headers['content-type'] || 'image/jpeg';
                        
                        contents.push({
                            inlineData: {
                                mimeType: mimeType,
                                data: buffer.toString('base64')
                            }
                        });
                    } else {
                        console.warn(`Failed to download binary for ${contextId}. Status: ${downloadResponse.status}`);
                    }
                }
            }

            // If context attachments (user-uploaded temp files) are provided, download and add them
            if (contextAttachments && contextAttachments.length > 0) {
                console.log(`Fetching ${contextAttachments.length} context attachment(s)...`);

                for (const attachment of contextAttachments) {
                    console.log(`Downloading attachment '${attachment.fileName}' (attachmentId: ${attachment.attachmentId})...`);
                    const downloadResponse = await authenticatedAxios.get('/binary/download', {
                        params: { tempFileId: attachment.attachmentId, filename: attachment.fileName },
                        responseType: 'arraybuffer',
                    });

                    if (downloadResponse.status === 200) {
                        const buffer = Buffer.from(downloadResponse.data);
                        const headerMime = downloadResponse.headers['content-type']?.split(';')[0].trim();
                        const mimeType = (headerMime && headerMime !== 'application/octet-stream')
                            ? headerMime
                            : (getImageMimeType(attachment.fileName) ?? 'image/jpeg');

                        contents.push({
                            inlineData: {
                                mimeType,
                                data: buffer.toString('base64'),
                            },
                        });
                    } else {
                        console.warn(`Failed to download attachment '${attachment.fileName}'. Status: ${downloadResponse.status}`);
                    }
                }
            }

            console.log(`Generating image for prompt: "${prompt}" with ${contents.length - 1} context images.`);
            let base64Content: string | undefined;
            
            const ai = new GoogleGenAI({ vertexai: false, apiKey: GEMINI_API_KEY });
            
            const generationConfig: any = {
                responseModalities: ['IMAGE']
            };

            if (aspectRatio) {
                generationConfig.imageConfig = { aspectRatio };
            }

            // Execute using the flat contents array
            const result = await ai.models.generateContent({
                model: "gemini-3.1-flash-image-preview",
                contents: contents,
                config: generationConfig
            });

            if (result?.candidates?.[0]?.content?.parts) {
                for (const part of result.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        base64Content = part.inlineData.data;
                        break;
                    }
                }
            }

            if (!base64Content) {
                const rejectionReason = result?.promptFeedback?.blockReason;
                const finishReason = result?.candidates?.[0]?.finishReason;
                console.log('No image data received', rejectionReason, finishReason);
                let errorMessage = "No image data was found in the API response.";
                if (rejectionReason) { errorMessage += ` Block Reason: ${rejectionReason}.`; }
                if (finishReason && finishReason !== "STOP") { errorMessage += ` Finish Reason: ${finishReason}.`; }
                throw new Error(errorMessage);
            }

            console.log("Image generated successfully.");

            const escapedContainerId = locationId.replace(':', '_');
            const existingTitles = new Set<string>();

            try {
                console.log(`Fetching existing component titles from folder ${locationId} to ensure uniqueness.`);
                const response = await authenticatedAxios.get(`/items/${escapedContainerId}/items`, {
                    params: {
                        rloItemTypes: ['Component'],
                        details: 'IdAndTitleOnly'
                    }
                });

                if (response.status === 200 && Array.isArray(response.data)) {
                    for (const item of response.data) {
                        if (item.Title) {
                            existingTitles.add(item.Title.toLowerCase());
                        }
                    }
                }
            } catch (error) {
                console.warn(`An error occurred while fetching items for uniqueness check. Proceeding with original title.`, error);
            }
            
            let uniqueTitle = title;
            let counter = 1;
            while (existingTitles.has(uniqueTitle.toLowerCase())) {
                uniqueTitle = `${title} (${counter})`;
                console.log(`Title collision detected. Trying new title: "${uniqueTitle}"`);
                counter++;
            }
            console.log(`Title "${uniqueTitle}" is available.`);

            const createComponentResult = await createMultimediaComponentFromBase64.execute({
                base64Content,
                title: uniqueTitle,
                fileName,
                locationId,
                schemaId,
                metadata
            }, context);

            return createComponentResult;

        } catch (error: any) {
            const contextMessage = "Failed to create multimedia component from prompt";
            console.log(contextMessage);
            return handleAxiosError(error, contextMessage);
        }
    }
};