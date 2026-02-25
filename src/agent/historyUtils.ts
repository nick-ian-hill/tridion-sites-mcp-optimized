import { Content, FunctionResponsePart } from './types.js';
import { filterResponseData } from '../utils/responseFiltering.js';

export const MAX_HISTORY_CHAR_LENGTH = 500000;

const COMPRESSION_THRESHOLD = 50000;

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

        // 2. COMPRESS PREVIOUS TURNS
        // For older history, we compress large function args and responses to save context window.
        const processedParts = msg.parts.map(part => {

            // Handle Model Function Calls (Compress Large Args)
            // Note: We use ...part to preserve thoughtSignature even in older history, though it's less critical there.
            if (msg.role === 'model' && 'functionCall' in part) {
                const argsString = JSON.stringify(part.functionCall.args);
                if (argsString.length > COMPRESSION_THRESHOLD) {
                    return {
                        ...part, // Important: Preserves 'thoughtSignature' if present
                        functionCall: {
                            name: part.functionCall.name,
                            args: { summary: `Large payload of ${argsString.length} chars` }
                        }
                    };
                }
            }

            // Handle Function Responses (Compress Large Outputs)
            if (msg.role === 'function' && 'functionResponse' in part) {
                const responseString = JSON.stringify(part.functionResponse.response);

                // Only compress if the output is actually large
                if (responseString.length > COMPRESSION_THRESHOLD) {
                    const filteredResponse = filterResponseData({
                        responseData: part.functionResponse.response,
                        details: 'IdAndTitle'
                    });
                    const newPart: FunctionResponsePart = {
                        functionResponse: { name: part.functionResponse.name, response: filteredResponse }
                    };
                    return newPart;
                }

                // If it is small enough, return it as-is (full fidelity)
                return part;
            }

            // Preserve everything else (specifically Thoughts/Reasoning parts or simple Text)
            return part;
        });

        return { ...msg, parts: processedParts };
    });

    let currentLength = JSON.stringify(preparedHistory).length;
    const preparedPercentage = Math.round((currentLength / MAX_HISTORY_CHAR_LENGTH) * 100);
    console.log(`[History Debug] Prepared history size for model: ${currentLength.toLocaleString()} / ${MAX_HISTORY_CHAR_LENGTH.toLocaleString()} chars (${preparedPercentage}%)`);

    // Safety valve: if history is still too big, drop the oldest messages entirely.
    // We prioritize dropping messages from the start of the array (oldest).
    // However, we MUST NOT drop messages from the 'protectionStartIndex' onwards if possible.
    while (currentLength > MAX_HISTORY_CHAR_LENGTH && preparedHistory.length > 2) {
        // Ensure we don't delete into the current turn unless absolutely necessary
        if (preparedHistory.length <= (preparedHistory.length - protectionStartIndex) + 1) {
            console.warn("[History Debug] Critical: Context limit reached, but cannot drop older frames without breaking current turn.");
            break;
        }

        preparedHistory.splice(1, 1); // Delete the second message (index 1), keeping the System/First User prompt (index 0) usually.
        currentLength = JSON.stringify(preparedHistory).length;
    }

    return preparedHistory;
}