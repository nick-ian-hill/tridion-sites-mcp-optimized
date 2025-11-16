import { z } from "zod";
import { createMultimediaComponentFromBase64 } from "./createMultimediaComponentFromBase64.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { handleAxiosError } from "../utils/errorUtils.js";
import { GoogleGenAI } from "@google/genai";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { sanitizeAgentJson } from "../utils/fieldReordering.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const createMultimediaComponentFromPromptInputProperties = {
    prompt: z.string().describe("The text prompt to generate an image from."),
    title: z.string().describe("The title for the new multimedia component."),
    fileName: z.string().describe("The desired file name for the multimedia component in the CMS (e.g., 'generated-image.jpg')."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new component will be created. Use 'search' or 'getItemsInContainer' to find a suitable Folder."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Multimedia Schema to use. If not provided, a default will be determined automatically. Use 'getSchemaLinks' with purpose 'Multimedia' to find available schemas."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields."),
    aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional().describe("The desired aspect ratio for the generated image. Defaults to 1:1 square if not specified.")
};

const createMultimediaComponentFromPromptSchema = z.object(createMultimediaComponentFromPromptInputProperties);

export const createMultimediaComponentFromPrompt = {
    name: "createMultimediaComponentFromPrompt",
    description: "Generates an image from a text prompt using the Gemini API and creates a new multimedia component from it. This is one of three ways to create a multimedia component, with the others being 'createMultimediaComponentFromBase64' and 'createMultimediaComponentFromUrl'.",
    input: createMultimediaComponentFromPromptInputProperties,
    async execute(input: z.infer<typeof createMultimediaComponentFromPromptSchema>,
        context: any
    ) {
        sanitizeAgentJson(input);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { prompt, title, fileName, locationId, schemaId, metadata, aspectRatio } = input;

        try {
            console.log(`Generating image for prompt: "${prompt}"`);
            let base64Content: string | undefined;
            
            const ai = new GoogleGenAI({ vertexai: false, apiKey: GEMINI_API_KEY });
            
            const generationConfig: any = {
                responseModalities: ['Image']
            };

            if (aspectRatio) {
                generationConfig.imageConfig = { aspectRatio };
            }

            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-image",
                contents: prompt,
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
                const authenticatedAxios = createAuthenticatedAxios(userSessionId);
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
                } else {
                    console.warn(`Could not verify title uniqueness due to unexpected API response format.`);
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
            if (error instanceof Error) {
                console.log('Error', error.message);
                const errorResponse = {
                    $type: 'Error',
                    Message: `${contextMessage}: ${error.message}`
                };
                return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }], errors: [], };
            }
            return handleAxiosError(error, contextMessage);
        }
    }
};