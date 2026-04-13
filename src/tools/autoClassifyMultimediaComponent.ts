import { z } from "zod";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { classify } from "./classify.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { extractIds } from "../utils/links.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const autoClassifyMultimediaInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/)
        .describe("The unique ID of the multimedia component to classify."),
    restrictToAutoClassificationFields: z.boolean().default(true).optional()
        .describe("If true (default), the tool strictly respects the Schema's 'AllowAutoClassification' property on Keyword fields. If false, it attempts to classify against ALL available keyword fields in the metadata."),
    maxSuggestions: z.number().int().default(5).optional()
        .describe("Maximum number of keywords to apply per category."),
    replaceExisting: z.boolean().default(false).optional()
        .describe("If true, removes ALL existing keywords from the target categories before adding the new suggestions."),
};

const autoClassifyMultimediaSchema = z.object(autoClassifyMultimediaInputProperties);

// Helper to validate mime type support for vision model
const getMimeType = (filename: string): string | null => {
    const lowercased = filename.toLowerCase();
    if (lowercased.endsWith('.png')) return 'image/png';
    if (lowercased.endsWith('.jpg') || lowercased.endsWith('.jpeg')) return 'image/jpeg';
    if (lowercased.endsWith('.webp')) return 'image/webp';
    if (lowercased.endsWith('.gif')) return 'image/gif';
    return null;
};

export const autoClassifyMultimediaComponent = {
    name: "autoClassifyMultimediaComponent",
    summary: "Automatically classifies an image component by analyzing its visual content using AI.",
    description: `Analyzes an image component and automatically classifies it by applying relevant Keywords from the item's Metadata Schema.
    
    This tool reads the item's Schema to find Keyword fields marked with 'AllowAutoClassification'. 
    It then sends the image and the available keywords to an AI vision model to select the best matches.`,

    input: autoClassifyMultimediaInputProperties,

    execute: async (input: z.infer<typeof autoClassifyMultimediaSchema>, context: any) => {
        const { itemId, restrictToAutoClassificationFields, maxSuggestions, replaceExisting } = input;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');

            // 1. Fetch Item to get Schema ID and Binary info
            const itemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: {
                    includeProperties: ["Metadata", "Schema", "BinaryContent", "ComponentType"]
                }
            });
            if (itemResponse.status !== 200) return handleUnexpectedResponse(itemResponse);

            const item = itemResponse.data;

            if (item.ComponentType !== 'Multimedia') {
                return { content: [{ type: "text", text: JSON.stringify({ message: "Item is not a Multimedia Component." }) }] };
            }

            const schemaId = item.Schema?.IdRef;
            if (!schemaId) {
                return { content: [{ type: "text", text: JSON.stringify({ message: "Item has no Schema. Skipping." }) }] };
            }

            // 2. Validate Image Type
            const filename = item.BinaryContent?.Filename;
            const mimeType = filename ? getMimeType(filename) : null;
            if (!mimeType) {
                return { content: [{ type: "text", text: JSON.stringify({ message: `Unsupported or missing file type for vision analysis: ${filename}` }) }] };
            }

            // 3. Fetch Schema Definition to find target categories
            const restSchemaId = schemaId.replace(':', '_');
            const schemaResponse = await authenticatedAxios.get(`/items/${restSchemaId}`);
            if (schemaResponse.status !== 200) return handleUnexpectedResponse(schemaResponse);

            const schema = schemaResponse.data;
            const metadataFields = schema.MetadataFields || {};
            const targetCategories: { id: string, title: string, fieldName: string }[] = [];

            // Find keyword fields in metadata
            for (const key in metadataFields) {
                const def = metadataFields[key];
                if (def.$type === 'KeywordFieldDefinition' && def.Category?.IdRef) {
                    if (def.AllowAutoClassification === true || !restrictToAutoClassificationFields) {
                        targetCategories.push({
                            id: def.Category.IdRef,
                            title: def.Name,
                            fieldName: key
                        });
                    }
                }
            }

            if (targetCategories.length === 0) {
                const msg = restrictToAutoClassificationFields
                    ? "No metadata fields found marked for Auto Classification."
                    : "No Keyword fields found in the Metadata Schema.";
                return { content: [{ type: "text", text: JSON.stringify({ message: msg }) }] };
            }

            // 4. Fetch Keywords for Targets & Build Prompt Context
            const categoryPrompts = [];
            const keywordIdMap: Record<string, string> = {};

            for (const cat of targetCategories) {
                const restCatId = cat.id.replace(':', '_');
                const keywordsResp = await authenticatedAxios.get(`/items/${restCatId}/keywords`);
                if (keywordsResp.status === 200) {
                    const keywords = keywordsResp.data;
                    const keywordNames = keywords.map((k: any) => {
                        keywordIdMap[k.Title] = k.Id;
                        return k.Title;
                    });

                    if (keywordNames.length > 0) {
                        categoryPrompts.push(`Category '${cat.title}': [${keywordNames.join(', ')}]`);
                    }
                }
            }

            if (categoryPrompts.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ message: "No keywords found in target categories." }) }] };
            }

            // 5. Download Binary
            const downloadResponse = await authenticatedAxios.get<ArrayBuffer>(
                `/items/${restItemId}/binary/download`,
                { responseType: 'arraybuffer' }
            );
            if (downloadResponse.status !== 200) return handleUnexpectedResponse(downloadResponse);

            const imageBuffer = Buffer.from(downloadResponse.data);
            const base64Content = imageBuffer.toString('base64');

            // 6. Call Gemini Vision
            if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured.");

            const outputSchema = z.object({
                selectedKeywords: z.array(z.string()).describe("The list of selected keyword titles.")
            });

            const prompt = `
            Analyze the provided image and select the most relevant keywords from the provided categories.
            Select up to ${maxSuggestions} keywords per category.
            
            Valid Keywords:
            ${categoryPrompts.join('\n')}
            
            Return ONLY a JSON object containing a 'selectedKeywords' array of strings.`;

            const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

            const imagePart = {
                inlineData: {
                    data: base64Content,
                    mimeType: mimeType,
                },
            };

            const result = await genAI.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [prompt, imagePart],
                config: {
                    responseMimeType: "application/json",
                    responseJsonSchema: zodToJsonSchema(outputSchema),
                    safetySettings: [{
                        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                        threshold: HarmBlockThreshold.BLOCK_NONE
                    }, {
                        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                        threshold: HarmBlockThreshold.BLOCK_NONE
                    }, {
                        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                        threshold: HarmBlockThreshold.BLOCK_NONE
                    }, {
                        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                        threshold: HarmBlockThreshold.BLOCK_NONE
                    }]
                }
            });

            const responseText = (result.text ?? "").trim();

            // 7. Parse Response
            let selectedKeywords: string[] = [];
            try {
                const parsedOutput = outputSchema.parse(JSON.parse(responseText));
                selectedKeywords = parsedOutput.selectedKeywords;
            } catch (e) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "AI response format error" }) }] };
            }

            const keywordIdsToAdd = selectedKeywords
                .map(name => keywordIdMap[name])
                .filter(id => id);

            if (keywordIdsToAdd.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "No Match", message: "AI did not select any relevant keywords from the image." }) }] };
            }

            // 8. Calculate Removals (if replaceExisting is true)
            let keywordIdsToRemove: string[] = [];
            if (replaceExisting) {
                for (const cat of targetCategories) {
                    if (item.Metadata) {
                        const existing = extractIds(item.Metadata[cat.fieldName]);
                        existing.forEach(id => keywordIdsToRemove.push(id));
                    }
                }
                const keywordsToAddSet = new Set(keywordIdsToAdd);
                keywordIdsToRemove = keywordIdsToRemove.filter(id => !keywordsToAddSet.has(id));
            }

            // 9. Execute Classify
            const classifyResult = await classify.execute({
                itemId: itemId,
                keywordIdsToAdd: keywordIdsToAdd,
                keywordIdsToRemove: keywordIdsToRemove.length > 0 ? keywordIdsToRemove : undefined
            }, context);

            // Enhance result
            if (classifyResult.content && classifyResult.content[0]) {
                const resultObj = JSON.parse(classifyResult.content[0].text);
                resultObj.AddedKeywords = keywordIdsToAdd;
                classifyResult.content[0].text = JSON.stringify(resultObj, null, 2);
            }

            return classifyResult;

        } catch (error) {
            return handleAxiosError(error, `Failed to auto-classify multimedia component ${itemId}`);
        }
    },
    examples: [
    ]
};