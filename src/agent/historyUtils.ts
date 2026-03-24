import { Content } from './types.js';

export const MAX_HISTORY_CHAR_LENGTH = 500000;

// --- Helper to aggressively truncate large arrays, objects, and strings in past turns ---
function compressPastPayload(data: any, maxItems: number = 3, maxKeys: number = 20): any {
    // 1. Catch and compress massive strings (e.g., base64 blobs, huge text logs)
    if (typeof data === 'string' && data.length > 2000) {
        // Keep the first 200 characters so the LLM has a tiny bit of context of what it was,
        // then append the truncation note.
        return `${data.substring(0, 200)}... [_compressionNote: Archived string truncated. Original length: ${data.length} chars]`;
    }

    // 2. Compress Arrays
    if (Array.isArray(data)) {
        if (data.length > maxItems) {
            return [
                ...data.slice(0, maxItems),
                { _compressionNote: `[Archived Turn] Array truncated. ${data.length - maxItems} items hidden.` }
            ];
        }
        return data.map(item => compressPastPayload(item, maxItems, maxKeys));
    } 
    
    // 3. Compress Objects recursively (with width limiting)
    else if (data !== null && typeof data === 'object') {
        const keys = Object.keys(data);
        const compressedObj: any = {};
        
        // A. If the object is too wide, truncate the keys
        if (keys.length > maxKeys) {
            for (const key of keys.slice(0, maxKeys)) {
                compressedObj[key] = compressPastPayload(data[key], maxItems, maxKeys);
            }
            compressedObj._compressionNote = `[Archived Turn] Object truncated. ${keys.length - maxKeys} keys hidden.`;
            return compressedObj;
        }

        // B. If the object is a normal size, process all keys
        for (const key of keys) {
            compressedObj[key] = compressPastPayload(data[key], maxItems, maxKeys);
        }
        return compressedObj;
    }

    // 4. Return standard small types (numbers, booleans, small strings)
    return data;
}

export function prepareHistoryForModel(history: Content[]): Content[] {
    const originalLength = JSON.stringify(history).length;
    const originalPercentage = Math.round((originalLength / MAX_HISTORY_CHAR_LENGTH) * 100);
    console.log(`[History Debug] Original history size: ${originalLength.toLocaleString()} / ${MAX_HISTORY_CHAR_LENGTH.toLocaleString()} chars (${originalPercentage}%)`);

    let preparedHistory = [...history];

    // Identify the start of the "Current Turn".
    // Gemini defines the current turn as everything since the last standard User text message.
    // We must preserve ALL Thought Signatures within this turn to satisfy strict validation.
    const lastUserTextIndex = preparedHistory.findLastIndex(msg =>
        msg.role === 'user' && msg.parts.some(p => 'text' in p)
    );

    // Fallback: If no user text is found (unlikely), protect the whole history to be safe.
    const protectionStartIndex = lastUserTextIndex === -1 ? 0 : lastUserTextIndex;

    preparedHistory = preparedHistory.map((msg, index) => {
        // 1. PROTECT THE CURRENT TURN
        // We return the message exactly as-is if it is part of the active reasoning chain.
        // This ensures 'thoughtSignature' fields are never stripped or modified during an active turn.
        if (index >= protectionStartIndex) {
            return msg;
        }

        // SAFETY FIX: Prevent crash if history contains malformed or empty messages
        if (!msg.parts || !Array.isArray(msg.parts)) {
            return msg;
        }

        // 2. COMPRESS PAST TURNS
        const compressedParts = msg.parts.map(part => {

            // A. Leave functionCalls (and their thoughtSignatures) EXACTLY as they are.
            if ('functionCall' in part) {
                return part;
            }

            // B. Aggressively truncate past function responses. 
            if ('functionResponse' in part) {
                const fr = part.functionResponse as any;
                return {
                    functionResponse: {
                        name: fr.name,
                        response: compressPastPayload(fr.response, 3)
                    }
                };
            }

            return part;
        });

        return { ...msg, parts: compressedParts };
    });

    let currentLength = JSON.stringify(preparedHistory).length;
    const preparedPercentage = Math.round((currentLength / MAX_HISTORY_CHAR_LENGTH) * 100);
    console.log(`[History Debug] Prepared history size for model: ${currentLength.toLocaleString()} / ${MAX_HISTORY_CHAR_LENGTH.toLocaleString()} chars (${preparedPercentage}%)`);

    // Safety valve: if history is still too big, drop the oldest messages entirely.
    // We prioritize dropping messages from the start of the array (oldest).
    // However, we MUST NOT drop messages from the 'protectionStartIndex' onwards if possible.
    let currentProtectionIndex = protectionStartIndex;

    while (currentLength > MAX_HISTORY_CHAR_LENGTH && preparedHistory.length > 3) {
        // If the protected turn has shifted all the way down to index 2, stop deleting!
        if (currentProtectionIndex <= 2) {
            console.warn("[History Debug] Critical: Context limit reached, but cannot drop older frames without breaking current turn.");
            break;
        }

        // Remove TWO messages (a pair) to maintain alternating roles
        preparedHistory.splice(1, 2);
        currentProtectionIndex -= 2;
        currentLength = JSON.stringify(preparedHistory).length;
    }

    return preparedHistory;
}