import { z } from "zod";
import { createAuthenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

// 1. Define input properties as a plain object.
const getBatchOperationStatusInputProperties = {
    batchId: z.string().regex(/^tcm:0-\d+-66048$/).describe("The unique ID of the batch operation item (e.g., 'tcm:0-123-66048')."),
};

// 2. Create the Zod schema from the properties object for type safety.
const getBatchOperationStatusSchema = z.object(getBatchOperationStatusInputProperties);

export const getBatchOperationStatus = {
    name: "getBatchOperationStatus",
    description: "Retrieves the current status of an asynchronous batch operation using its unique batch ID. Provides a summary of the progress and the status for each individual item in the batch.",

    // 3. Export the PLAIN object for VS Code tooling.
    input: getBatchOperationStatusInputProperties,

    // 4. Use z.infer for the execute function's input type.
    execute: async (input: z.infer<typeof getBatchOperationStatusSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { batchId } = input;
        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedBatchId = batchId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${escapedBatchId}`);

            if (response.status === 200) {
                const batch = response.data;

                if (typeof batch.TotalNumberOfOperations === 'undefined' || typeof batch.NumberOfDoneOperations === 'undefined') {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Item ${batchId} is not a valid batch operation object.`
                        }]
                    };
                }

                const total = batch.TotalNumberOfOperations;
                const processed = batch.NumberOfDoneOperations;
                const isCompleted = processed === total;
                const operation = batch.Operations[0]?.Operation || 'N/A';
                
                let summary = `Batch Operation Status for ${batchId}: ${isCompleted ? 'Completed' : 'In Progress'}\n`;
                summary += `Progress: ${processed} / ${total} items processed.\n`;
                summary += `Operation: ${operation}`;

                const statuses = batch.Operations[0]?.Statuses || [];
                if (statuses.length > 0) {
                    summary += "\n\n--- Item Statuses ---\n";
                    const itemDetails = statuses.map((s: any) => {
                        const details = s.Information || s.ErrorCode || 'OK';
                        return `- Item: ${s.SubjectId}, Status: ${s.State}, Details: ${details}`;
                    }).join('\n');
                    summary += itemDetails;
                }

                return {
                    content: [{
                        type: "text",
                        text: summary
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to retrieve status for batch operation ${batchId}`);
        }
    }
};