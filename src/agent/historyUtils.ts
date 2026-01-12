import { Content, FunctionResponsePart } from './types.js';
import { filterResponseData } from '../utils/responseFiltering.js';

export const MAX_HISTORY_CHAR_LENGTH = 500000;

const ARG_COMPRESSION_THRESHOLD = 20000;

export function prepareHistoryForModel(history: Content[]): Content[] {
    const originalLength = JSON.stringify(history).length;
    const originalPercentage = Math.round((originalLength / MAX_HISTORY_CHAR_LENGTH) * 100);
    console.log(`[History Debug] Original history size: ${originalLength.toLocaleString()} / ${MAX_HISTORY_CHAR_LENGTH.toLocaleString()} chars (${originalPercentage}%)`);

    let preparedHistory = [...history];

    // Find the index of the last tool interaction (both the call and its response)
    const lastFunctionResponseIndex = preparedHistory.findLastIndex(msg => msg.role === 'function');
    const lastFunctionCallIndex = lastFunctionResponseIndex > 0 ? lastFunctionResponseIndex - 1 : -1;

    preparedHistory = preparedHistory.map((msg, index) => {
        // We will compress any message that is NOT part of the last tool interaction.
        const isPartOfLastInteraction = (index === lastFunctionCallIndex || index === lastFunctionResponseIndex);
        if (isPartOfLastInteraction) {
            return msg; // Keep the last interaction in high fidelity.
        }

        // We map over parts to ensure we preserve "Thinking" parts while compressing "FunctionCall" parts.
        const processedParts = msg.parts.map(part => {
            
            // 1. Handle Model Function Calls (Compress Large Args)
            // We check if this specific part is a function call.
            if (msg.role === 'model' && 'functionCall' in part) {
                const argsString = JSON.stringify(part.functionCall.args);
                if (argsString.length > ARG_COMPRESSION_THRESHOLD) { 
                    return {
                        ...part, // <--- CHANGED: Spread existing props to preserve 'thoughtSignature'
                        functionCall: {
                            name: part.functionCall.name,
                            args: { summary: `Large payload of ${argsString.length} chars` }
                        }
                    };
                }
            }
            
            // 2. Handle Function Responses (Filter Data)
            // We check if this specific part is a function response.
            if (msg.role === 'function' && 'functionResponse' in part) {
                const filteredResponse = filterResponseData({
                    responseData: part.functionResponse.response,
                    details: 'IdAndTitle'
                });
                const newPart: FunctionResponsePart = {
                    functionResponse: { name: part.functionResponse.name, response: filteredResponse }
                };
                return newPart;
            }

            // 3. Preserve everything else (specifically Thoughts/Reasoning parts)
            return part;
        });
        
        return { ...msg, parts: processedParts };
    });

    let currentLength = JSON.stringify(preparedHistory).length;
    const preparedPercentage = Math.round((currentLength / MAX_HISTORY_CHAR_LENGTH) * 100);
    console.log(`[History Debug] Prepared history size for model: ${currentLength.toLocaleString()} / ${MAX_HISTORY_CHAR_LENGTH.toLocaleString()} chars (${preparedPercentage}%)`);

    while (currentLength > MAX_HISTORY_CHAR_LENGTH && preparedHistory.length > 2) {
        preparedHistory.splice(1, 1);
        currentLength = JSON.stringify(preparedHistory).length;
    }

    return preparedHistory;
}