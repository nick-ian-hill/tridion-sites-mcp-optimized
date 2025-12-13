import { z } from "zod";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

export const generateContentFromPrompt = {
    name: "generateContentFromPrompt",
    description: `Generates text content based on a prompt, with optional context and stylistic guidance.
    This tool is designed to be a flexible generation engine. 
    - Use 'prompt' for the specific task (e.g., "Summarize this", "Translate to Spanish").
    - Use 'sourceText' to provide the source material.
    - Use 'guidance' to enforce a specific voice, tone, or brand style (e.g., "Use a professional, concise tone", "Format as a LinkedIn post").
    
    This separation allows you to use the tool in loops to generate multiple variants of the same content with different guidelines.`,
    
    input: {
        prompt: z.string()
            .describe("The core instruction for the content generation."),
        
        sourceText: z.string().optional()
            .describe("The source text to operate on (e.g., the body of an article to be rewritten or translated)."),
            
        guidance: z.string().optional()
            .describe("Stylistic instructions, brand guidelines, or formatting rules. This sets the 'persona' of the AI for this generation."),
            
        creativityLevel: z.enum(["low", "medium", "high"]).optional().default("medium")
            .describe("Controls the temperature. 'low' for factual tasks, 'high' for creative writing.")
    },

    async execute(
        { prompt, sourceText, guidance, creativityLevel = "medium" }: 
        { prompt: string; sourceText?: string; guidance?: string; creativityLevel?: "low" | "medium" | "high" },
        context: any
    ) {
        if (!GEMINI_API_KEY) {
            return { content: [{ type: "text", text: JSON.stringify({ type: 'Error', Message: "GEMINI_API_KEY not configured." }, null, 2) }] };
        }

        try {
            const temperatureMap = { low: 0.2, medium: 0.5, high: 0.8 };
            const temperature = temperatureMap[creativityLevel];

            // Construct a structured prompt
            const parts = [];
            
            // 1. Guidance (System/Persona instruction)
            if (guidance) {
                parts.push(`--- GUIDELINES & VOICE ---\n${guidance}\n`);
            }

            // 2. Context (The data to work on)
            if (sourceText) {
                parts.push(`--- SOURCE CONTENT ---\n${sourceText}\n`);
            }

            // 3. The Task
            parts.push(`--- INSTRUCTION ---\n${prompt}`);

            console.log(`[generateContent] Calling Gemini (Temp: ${temperature})...`);
            
            const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
            const result = await genAI.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: [{ role: 'user', parts: [{ text: parts.join("\n\n") }] }],
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
                    text: JSON.stringify({
                        type: "GeneratedContent",
                        Content: generatedText
                    }, null, 2)
                }],
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { 
                content: [{ type: "text", text: JSON.stringify({ type: 'Error', Message: `Generation failed: ${errorMessage}` }, null, 2) }] 
            };
        }
    }
};