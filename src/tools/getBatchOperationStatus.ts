import { z } from "zod";
import { authenticatedAxios } from "../lib/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../lib/errorUtils.js";

export const getBatchOperationStatus = {
    name: "getBatchOperationStatus",
    description: "Retrieves the current status of an asynchronous batch operation using its unique batch ID. Provides a summary of the progress and the status for each individual item in the batch.",
    input: {
        batchId: z.string().regex(/^tcm:0-\d+-66048$/).describe("The unique ID of the batch operation item (e.g., 'tcm:0-123-66048')."),
    },
    execute: async ({ batchId }: { batchId: string }) => {
        try {
            const escapedBatchId = batchId.replace(':', '_');
            const response = await authenticatedAxios.get(`/items/${escapedBatchId}`);

            if (response.status === 200) {
                const batch = response.data;

                // Validate that the response is a batch object by checking for key properties.
                if (typeof batch.TotalNumberOfOperations === 'undefined' || typeof batch.NumberOfDoneOperations === 'undefined') {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Item ${batchId} is not a valid batch operation object.`
                        }]
                    };
                }

                const total = batch.TotalNumberOfOperations; //
                const processed = batch.NumberOfDoneOperations; //
                const isCompleted = processed === total;
                const operation = batch.Operations[0]?.Operation || 'N/A'; //
                
                let summary = `Batch Operation Status for ${batchId}: ${isCompleted ? 'Completed' : 'In Progress'}\n`;
                summary += `Progress: ${processed} / ${total} items processed.\n`;
                summary += `Operation: ${operation}`;

                const statuses = batch.Operations[0]?.Statuses || []; //
                if (statuses.length > 0) {
                    summary += "\n\n--- Item Statuses ---\n";
                    const itemDetails = statuses.map((s: any) => {
                        const details = s.Information || s.ErrorCode || 'OK'; //
                        return `- Item: ${s.SubjectId}, Status: ${s.State}, Details: ${details}`; //
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