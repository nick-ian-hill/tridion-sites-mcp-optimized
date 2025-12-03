import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { formatForAgent } from "../utils/fieldReordering.js";

const getBatchOperationStatusInputProperties = {
    batchId: z.string().regex(/^tcm:0-\d+-66048$/).describe("The unique ID of the batch operation item (e.g., 'tcm:0-123-66048')."),
};

const getBatchOperationStatusSchema = z.object(getBatchOperationStatusInputProperties);

export const getBatchOperationStatus = {
    name: "getBatchOperationStatus",
    description: `Retrieves the current status of an asynchronous batch operation using its unique batch ID. A batch ID is returned by tools such as 'batchCheckIn', 'batchCheckOut', 'batchClassification', 'batchDeleteItems', 'batchLocalizeItems', 'batchUndoCheckOut', and 'batchUnlocalizeItems'. This tool provides a summary of the progress and the status for each individual item in the batch.`,

    input: getBatchOperationStatusInputProperties,

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
                    const errorResponse = {
                        type: 'Error',
                        Message: `Error: Item ${batchId} is not a valid batch operation object.`
                    };
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(errorResponse, null, 2)
                        }]
                    };
                }

                const total = batch.TotalNumberOfOperations;
                const processed = batch.NumberOfDoneOperations;
                const isCompleted = processed === total;
                const operation = batch.Operations[0]?.Operation || 'N/A';
                
                const itemStatuses = (batch.Operations[0]?.Statuses || []).map((s: any) => ({
                    Id: s.SubjectId,
                    Status: s.State,
                    Details: s.Information || s.ErrorCode || 'OK'
                }));

                const jsonResponse = {
                    $type: "BatchStatus",
                    Id: batchId,
                    Operation: operation,
                    IsCompleted: isCompleted,
                    ItemsProcessed: processed,
                    ItemsTotal: total,
                    ItemStatuses: itemStatuses
                };

                const formattedJsonResponse = formatForAgent(jsonResponse);

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedJsonResponse, null, 2)
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