import { z } from "zod";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

export const generateContentFromPrompt = {
    name: "generateContentFromPrompt",
    description: `The only tool for generating creative, marketing-oriented, or suggestive text. This tool uses a special configuration optimized for creativity. Use this for all requests for webpage copy, product descriptions, blog posts, or marketing ideas.
The generated text can then be used as input for other tools, such as the 'content' parameter in 'createItem' or 'updateContent', or to populate metadata fields with 'updateMetadata'.`,
    input: {
        prompt: z.string().describe("A detailed prompt describing the content to be generated, including the desired topic, tone, style, and approximate length."),
        creativityLevel: z.enum(["low", "medium", "high"]).optional().default("medium").describe("Controls the creativity of the response. 'low' is for more factual, predictable text. 'medium' offers a good balance. 'high' is for more imaginative and unexpected content."),
        contextualText: z.string().optional().describe("Optional. A block of existing text to use as context for the generation (e.g., for summarization, rewriting, or expansion).")
    },
    async execute(
        { prompt, creativityLevel = "medium", contextualText }: { prompt: string; creativityLevel?: "low" | "medium" | "high"; contextualText?: string },
        context: any
    ) {
        if (!GEMINI_API_KEY) {
            return { content: [{ type: "text", text: "Error: GEMINI_API_KEY is not configured for this tool." }] };
        }

        try {
            // Map the user-friendly creativity level to a specific temperature value.
            const temperatureMap = {
                low: 0.2,
                medium: 0.5,
                high: 0.8
            };
            const temperature = temperatureMap[creativityLevel];

            let finalPrompt = prompt;
            if (contextualText) {
                finalPrompt = `Based on the following text, perform this instruction.

Instruction: "${prompt}"

Text to use as context:
---
${contextualText}
---`;
            }

            console.log(`[generateContent] Calling Gemini with temperature: ${temperature}`);
            
            const genAI = new GoogleGenAI({apiKey: GEMINI_API_KEY});
            
            const result = await genAI.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: finalPrompt,
                config: {
                    temperature: temperature,
                    safetySettings: [{
                        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                        threshold: HarmBlockThreshold.BLOCK_NONE
                    }]
                }
            });

            const generatedText = (result.text ?? "").trim();

            return {
                content: [{
                    type: "text",
                    text: generatedText
                }],
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[generateContent] Error: ${errorMessage}`);
            return { content: [{ type: "text", text: `Error generating content: ${errorMessage}` }] };
        }
    }
};