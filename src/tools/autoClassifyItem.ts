import { z } from "zod";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { classify } from "./classify.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { extractIds } from "../utils/links.js"; // <-- Updated: Import now comes from utils/links.js

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const autoClassifyItemInputProperties = {
    itemId: z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)
        .describe("The unique ID of the item to classify."),
    restrictToAutoClassifiableFields: z.boolean().default(true).optional()
        .describe("If true (default), the tool strictly respects the Schema's 'UseForAutoClassification' (source text) and 'AllowAutoClassification' (target keyword) properties. If false, it uses all text content and all available keyword fields."),
    maxSuggestions: z.number().int().default(5).optional()
        .describe("Maximum number of keywords to apply per category."),
    replaceExisting: z.boolean().default(false).optional()
        .describe("If true, removes ALL existing keywords from the target categories before adding the new suggestions. Use this to re-classify items."),
};

const autoClassifyItemSchema = z.object(autoClassifyItemInputProperties);

// Helper to extract text from specific fields in the content object
const extractTextFromFields = (content: any, fieldNames: Set<string>): string[] => {
    let text: string[] = [];
    if (!content || typeof content !== 'object') return text;

    for (const key in content) {
        if (fieldNames.has(key)) {
            const val = content[key];
            if (typeof val === 'string') text.push(val);
            // Handle rich text or other simple types if needed
        }
        // Recurse for embedded fields if they match the path logic (simplified here to top-level or direct match)
    }
    return text;
};

// Fallback helper to extract ALL text if restriction is off
const extractAllText = (obj: any): string[] => {
    let text: string[] = [];
    if (!obj) return text;

    if (typeof obj === 'string') {
        if (obj.length > 20 && !obj.startsWith('tcm:') && !obj.startsWith('ecl:')) {
            text.push(obj);
        }
    } else if (Array.isArray(obj)) {
        obj.forEach(child => text = text.concat(extractAllText(child)));
    } else if (typeof obj === 'object') {
        for (const key in obj) {
            if (!key.startsWith('$') && key !== 'Id' && key !== 'Title') {
                text = text.concat(extractAllText(obj[key]));
            }
        }
    }
    return text;
};

export const autoClassifyItem = {
    name: "autoClassifyItem",
    description: `Analyzes an item's content and automatically classifies it by applying relevant Keywords.
    
    It respects the item's Schema definition:
    - It reads text from fields marked 'UseForAutoClassification'.
    - It applies keywords only to fields marked 'AllowAutoClassification'.
    
    If 'restrictToAutoClassifiableFields' is true, the tool will SKIP classification if the Schema does not have at least one valid source field AND one valid target keyword field.

    Example:
    const result = await tools.autoClassifyItem({
        itemId: "tcm:5-200",
        restrictToAutoClassifiableFields: true,
        replaceExisting: true
    });
    
    Expected Output:
    {
        "type": "ClassificationResult",
        "Id": "tcm:5-200",
        "Message": "Successfully classified tcm:5-200",
        "AddedKeywords": ["tcm:5-1024-1024", "tcm:5-1025-1024"]
    }`,

    input: autoClassifyItemInputProperties,

    execute: async (input: z.infer<typeof autoClassifyItemSchema>, context: any) => {
        const { itemId, restrictToAutoClassifiableFields, maxSuggestions, replaceExisting } = input;
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const restItemId = itemId.replace(':', '_');

            // 1. Fetch Item to get Content and Schema ID
            console.log(`Fetching item ${itemId}...`);
            const itemResponse = await authenticatedAxios.get(`/items/${restItemId}`, {
                params: {
                    includeProperties: ["Content", "Metadata", "Schema"]
                }
            });
            if (itemResponse.status !== 200) return handleUnexpectedResponse(itemResponse);

            const item = itemResponse.data;
            const schemaId = item.Schema?.IdRef;

            if (!schemaId) {
                return { content: [{ type: "text", text: JSON.stringify({ message: "Item has no Schema. Skipping." }) }] };
            }

            // 2. Fetch Schema Definition to check flags
            const restSchemaId = schemaId.replace(':', '_');
            const schemaResponse = await authenticatedAxios.get(`/items/${restSchemaId}`);
            if (schemaResponse.status !== 200) return handleUnexpectedResponse(schemaResponse);
            const schema = schemaResponse.data;

            const contentFields = schema.Fields || {};
            const metadataFields = schema.MetadataFields || {};

            const sourceTextFields = new Set<string>();
            const targetCategories: { id: string, title: string, fieldName: string }[] = [];

            // Helper to scan definition dictionaries
            const scanDefinition = (defs: any) => {
                for (const key in defs) {
                    const def = defs[key];

                    // Check for Source Text Fields
                    if (def.UseForAutoClassification === true) {
                        sourceTextFields.add(key);
                    } else if (!restrictToAutoClassifiableFields) {
                        // If restriction is OFF, we treat mostly everything as source
                        // (Logic handled by extractAllText later if set is empty)
                    }

                    // Check for Target Keyword Fields
                    if (def.$type === 'KeywordFieldDefinition' && def.Category?.IdRef) {
                        if (def.AllowAutoClassification === true || !restrictToAutoClassifiableFields) {
                            targetCategories.push({
                                id: def.Category.IdRef,
                                title: def.Name,
                                fieldName: key
                            });
                        }
                    }
                }
            };

            scanDefinition(contentFields);
            scanDefinition(metadataFields);

            // 3. Validation Logic (Strict Mode)
            if (restrictToAutoClassifiableFields) {
                const hasSource = sourceTextFields.size > 0;
                const hasTarget = targetCategories.length > 0;

                if (!hasSource || !hasTarget) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: "Skipped",
                                reason: "Schema configuration mismatch.",
                                details: `Has valid source text fields: ${hasSource}. Has valid target keyword fields: ${hasTarget}.`
                            }, null, 2)
                        }]
                    };
                }
            }

            // 4. Extract Content
            let textToAnalyze = "";
            if (restrictToAutoClassifiableFields) {
                const cText = extractTextFromFields(item.Content, sourceTextFields);
                const mText = extractTextFromFields(item.Metadata, sourceTextFields);
                textToAnalyze = [...cText, ...mText].join("\n\n");
            } else {
                const cText = extractAllText(item.Content);
                const mText = extractAllText(item.Metadata);
                textToAnalyze = `Title: ${item.Title}\n\n${[...cText, ...mText].join("\n\n")}`;
            }

            if (textToAnalyze.length < 50) {
                return { content: [{ type: "text", text: JSON.stringify({ message: "Insufficient text content found for analysis." }) }] };
            }

            // 5. Fetch Keywords for Targets & Build Prompt
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

            // 6. Call Gemini
            if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured.");

            const outputSchema = z.object({
                selectedKeywords: z.array(z.string()).describe("The list of selected keyword titles.")
            });

            const prompt = `
            Analyze the following text and select the most relevant keywords from the provided categories.
            Select up to ${maxSuggestions} keywords per category.
            
            Valid Keywords:
            ${categoryPrompts.join('\n')}
            
            Text to Analyze:
            ---
            ${textToAnalyze.substring(0, 20000)} 
            ---
            
            Return ONLY a JSON object containing a 'selectedKeywords' array of strings.
            Example: { "selectedKeywords": ["Sports", "Finance"] }`;

            console.log("Calling Gemini for classification...");
            const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

            // Corrected API usage for @google/genai package
            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: prompt,
                config: {
                    temperature: 0,
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

            // 7. Parse and Apply
            let selectedKeywords: string[] = [];
            try {
                const parsedOutput = outputSchema.parse(JSON.parse(responseText));
                selectedKeywords = parsedOutput.selectedKeywords;
            } catch (e) {
                return { content: [{ type: "text", text: JSON.stringify({ error: "AI response format error" }) }] };
            }

            const keywordIdsToAdd = selectedKeywords
                .map(name => keywordIdMap[name])
                .filter(id => id); // Filter valid IDs

            if (keywordIdsToAdd.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ status: "No Match", message: "AI did not select any relevant keywords." }) }] };
            }

            // 8. Execute Classify Action
            console.log(`Applying ${keywordIdsToAdd.length} keywords to ${itemId}...`);

            let keywordIdsToRemove: string[] = [];
            if (replaceExisting) {
                // Collect existing keywords ONLY from the target categories/fields
                for (const cat of targetCategories) {
                    // Check Metadata
                    if (item.Metadata) {
                        const existing = extractIds(item.Metadata[cat.fieldName]);
                        existing.forEach(id => keywordIdsToRemove.push(id));
                    }
                    // Check Content (less common for keywords, but possible)
                    if (item.Content) {
                        const existing = extractIds(item.Content[cat.fieldName]);
                        existing.forEach(id => keywordIdsToRemove.push(id));
                    }
                }
                // Filter out any IDs we are also adding, to avoid redundant operations/errors
                const keywordsToAddSet = new Set(keywordIdsToAdd);
                keywordIdsToRemove = keywordIdsToRemove.filter(id => !keywordsToAddSet.has(id));
            }

            // Reuse the existing classify tool logic directly
            const classifyResult = await classify.execute({
                itemId: itemId,
                keywordIdsToAdd: keywordIdsToAdd,
                keywordIdsToRemove: keywordIdsToRemove.length > 0 ? keywordIdsToRemove : undefined
            }, context);

            // Enhance result with details for the agent
            if (classifyResult.content && classifyResult.content[0]) {
                const resultObj = JSON.parse(classifyResult.content[0].text);
                resultObj.AddedKeywords = keywordIdsToAdd;
                classifyResult.content[0].text = JSON.stringify(resultObj, null, 2);
            }

            return classifyResult;

        } catch (error) {
            return handleAxiosError(error, `Failed to auto-classify item ${itemId}`);
        }
    }
};