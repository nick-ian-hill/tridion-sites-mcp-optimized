import { Content, FunctionResponsePart } from './types.js';
import { filterResponseData } from '../utils/responseFiltering.js';

export const MAX_HISTORY_CHAR_LENGTH = 500000;

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

        const part = msg.parts[0];

        // If it's an old functionCall with large args, compress them.
        if (msg.role === 'model' && part && 'functionCall' in part) {
            const argsString = JSON.stringify(part.functionCall.args);
            if (argsString.length > 250) { 
                return {
                    ...msg,
                    parts: [{
                        functionCall: {
                            name: part.functionCall.name,
                            args: { summary: `Large payload of ${argsString.length} chars` }
                        }
                    }]
                };
            }
        }
        
        if (msg.role === 'function' && part && 'functionResponse' in part) {
            const filteredResponse = filterResponseData({
                responseData: part.functionResponse.response,
                details: 'IdAndTitle'
            });
            const newPart: FunctionResponsePart = {
                functionResponse: { name: part.functionResponse.name, response: filteredResponse }
            };
            return { ...msg, parts: [newPart] };
        }
        
        return msg;
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