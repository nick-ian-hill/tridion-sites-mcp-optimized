import axios, { AxiosResponse } from "axios";
import { formatForAgent } from "./fieldReordering.js";

/**
 * The standard return structure for a tool's execute function.
 */
interface ToolResult {
    content: { type: "text"; text: string }[];
    errors: { message: string }[];
}

/**
 * Formats an error, especially from Axios, into a standardized object.
 * The formatted error message is placed in the `content` property
 * as a JSON string.
 *
 * @param error - The error object caught in a try-catch block.
 * @param contextMessage - A descriptive message providing context for the error
 * (e.g., "Failed to create CMS item").
 * @returns A ToolResult object with the formatted error in the content property.
 */
export function handleAxiosError(error: unknown, contextMessage: string): ToolResult {
    const errorMessage = axios.isAxiosError(error)
        ? (error.response
            ? `API Error Status ${error.response.status}: ${JSON.stringify(error.response.data)}`
            : error.message)
        : String(error);

    const fullMessage = `${contextMessage}: ${errorMessage}`;

    const sanitizedMessage = fullMessage.replace(/\$type/g, 'type');

    const errorResponse = {
        $type: 'Error',
        Message: sanitizedMessage
    };

    const formattedError = formatForAgent(errorResponse);

    return {
        content: [{
            type: "text",
            text: JSON.stringify(formattedError, null, 2)
        }],
        errors: [], // Keep the errors array empty as requested
    };
}

/**
 * Creates a standardized error response for unexpected API status codes.
 * The error message is placed in the `content` property as a JSON string.
 *
 * @param response - The Axios response object.
 * @returns A ToolResult object with the unexpected status message.
 */
export function handleUnexpectedResponse(response: AxiosResponse): ToolResult {
    const message = `Unexpected response status: ${response.status}. Message: ${response.statusText}`;
    console.error(message, response.data);

    const errorResponse = {
        $type: 'Error',
        Message: message
    };

    const formattedError = formatForAgent(errorResponse);

    return {
        content: [{
            type: "text",
            text: JSON.stringify(formattedError, null, 2)
        }],
        errors: [], // Keep the errors array empty as requested
    };
}