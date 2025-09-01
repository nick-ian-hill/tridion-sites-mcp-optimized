import { z } from "zod";
import { createMultimediaComponentFromBase64 } from "./createMultimediaComponentFromBase64.js";
import { fieldValueSchema } from "../schemas/fieldValueSchema.js";
import { handleAxiosError } from "../lib/errorUtils.js";
import { GoogleGenAI } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const createMultimediaComponentFromPromptInputProperties = {
    prompt: z.string().describe("The text prompt to generate an image from."),
    title: z.string().describe("The title for the new multimedia component."),
    fileName: z.string().describe("The desired file name for the multimedia component in the CMS (e.g., 'generated-image.jpg')."),
    locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new component will be created."),
    schemaId: z.string().regex(/^tcm:\d+-\d+-8$/).optional().describe("The TCM URI of the Multimedia Schema to use. If not provided, a default will be determined automatically."),
    metadata: z.record(fieldValueSchema).optional().describe("A JSON object for the item's metadata fields.")
};

const createMultimediaComponentFromPromptSchema = z.object(createMultimediaComponentFromPromptInputProperties);

export const createMultimediaComponentFromPrompt = {
    name: "createMultimediaComponentFromPrompt",
    description: "Generates an image from a text prompt using the Gemini API and creates a new multimedia component from the generated image.",
    input: createMultimediaComponentFromPromptInputProperties,
    async execute(input: z.infer<typeof createMultimediaComponentFromPromptSchema>) {
        const { prompt, title, fileName, locationId, schemaId, metadata } = input;

        const ai = new GoogleGenAI({ vertexai: false, apiKey: GEMINI_API_KEY });

        try {
            console.log(`Generating image for prompt: "${prompt}"`);

            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-image-preview",
                contents: prompt
            });

            let base64Content: string | undefined; // 'R0lGODlhAQABAIAAAP8AADAAACwAAAAAAQABAAACAkQBADs=';

            // Find the image data by iterating through parts
            if (result?.candidates?.[0]?.content?.parts) {
                for (const part of result.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        base64Content = part.inlineData.data;
                        break; // Exit the loop once we've found the image
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

            console.log("Image generated successfully. Creating multimedia component...");

            const createComponentResult = await createMultimediaComponentFromBase64.execute({
                base64Content,
                title,
                fileName,
                locationId,
                schemaId,
                metadata
            });

            return createComponentResult;

        } catch (error: any) {
            const contextMessage = "Failed to create multimedia component from prompt";
            console.log(contextMessage);
            if (error instanceof Error) {
                console.log('Error', error.message);
                return { content: [{ type: "text", text: `${contextMessage}: ${error.message}` }], errors: [], };
            }
            return handleAxiosError(error, contextMessage);
        }
    }
};