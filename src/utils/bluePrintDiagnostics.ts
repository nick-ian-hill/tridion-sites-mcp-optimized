import { AxiosInstance, isAxiosError } from "axios";
import { convertItemIdToContextPublication } from "./convertItemIdToContextPublication.js";

// Regex to identify potential TCM URIs in the input
const TCM_REGEX = /^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/;

/**
 * Recursively extracts all unique TCM/ECL URIs from an input object.
 */
function extractIds(obj: any, ids: Set<string> = new Set()): Set<string> {
    if (!obj) return ids;

    if (typeof obj === 'string') {
        if (TCM_REGEX.test(obj)) {
            ids.add(obj);
        }
    } else if (Array.isArray(obj)) {
        obj.forEach(item => extractIds(item, ids));
    } else if (typeof obj === 'object') {
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                extractIds(obj[key], ids);
            }
        }
    }
    return ids;
}

/**
 * Intercepts 404 errors to check for BluePrint "Sibling Isolation" issues.
 * * Logic:
 * 1. If the error is NOT a 404, return immediately (no overhead).
 * 2. Extract all TCM URIs from the tool's input arguments.
 * 3. For each URI, calculate what it was mapped to in the current context.
 * 4. If the Mapped ID fails (404) but the Original ID exists (200), we found the cause.
 * 5. Throw a descriptive, actionable error for the Agent.
 * * @param error The original error caught in the tool.
 * @param inputs The arguments passed to the tool (e.g., { schemaId: "...", content: ... }).
 * @param contextId The location context (e.g., the folder ID where creation is happening).
 * @param axiosInstance The authenticated Axios instance.
 */
export async function diagnoseBluePrintError(
    error: unknown,
    inputs: any,
    contextId: string,
    axiosInstance: AxiosInstance
): Promise<void> {
    // 1. Zero Overhead Check: Only run on 404 errors
    if (!isAxiosError(error) || error.response?.status !== 404) {
        return;
    }

    // 2. Extraction Phase
    const allIds = extractIds(inputs);
    
    // 3. Diagnostic Loop
    for (const originalId of allIds) {
        // Ignore the context ID itself
        if (originalId === contextId) continue;

        const mappedId = convertItemIdToContextPublication(originalId, contextId);

        // Only investigate if mapping actually changed the ID (i.e., it was a parent/sibling ref)
        if (mappedId === originalId) continue;

        try {
            // Check if the MAPPED item exists (Fastest check)
            // We assume it doesn't, because we just got a 404, but we verify specifically for this ID.
            await axiosInstance.head(`/items/${mappedId.replace(':', '_')}`);
        } catch (mappedError) {
            if (isAxiosError(mappedError) && mappedError.response?.status === 404) {
                // The mapped item definitely does not exist.
                // CRITICAL CHECK: Does the ORIGINAL item exist?
                try {
                    await axiosInstance.head(`/items/${originalId.replace(':', '_')}`);

                    // SUCCESS: We found the root cause.
                    // The original exists, but it is not visible in this context.
                    throw new Error(
                        `BluePrint Isolation Error: The item '${originalId}' exists, but it is NOT visible in the current publication context ('${contextId}').\n` +
                        `This typically means '${originalId}' is located in a Sibling or Child Publication, not a Parent.\n` +
                        `Action Required: You must first use the 'promoteItem' tool to move '${originalId}' to a common Parent Publication so it can be shared.`
                    );
                } catch (originalCheckError) {
                    // Original doesn't exist either, or we can't reach it. 
                    // Ignore and let the standard error handler report the original 404.
                }
            }
        }
    }
    
    // If no specific BluePrint issue was found, we return normally.
    // The caller will then throw the standard error.
}