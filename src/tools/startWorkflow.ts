import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { toLink, toLinkArray } from "../utils/links.js";

export const startWorkflow = {
    name: "startWorkflow",
    summary: "Initiates a new workflow process for content review and approval.",
    description: `Starts a new workflow process and optionally includes one or more items ('subjects') from the corresponding publication. This is commonly used to ensure changes to items go through a review and approval process.`,
    input: {
        publicationId: z.string().regex(/^tcm:0-[1-9]\d*-1$/)
            .describe("The ID of the publication where the workflow will run (e.g., 'tcm:0-5-1'). Use 'getPublications' to find the correct ID."),
        workflowTitle: z.string()
            .describe("The overall title for this workflow instance (e.g., 'Prepare Q4 Campaign Assets.')."),
        taskTitle: z.string()
            .describe("The title for the first task in the workflow (e.g., 'Classify the related items.')."),
        processDefinitionId: z.string().regex(/^tcm:\d+-\d+-131074$/)
            .describe("The ID of the workflow definition to use (e.g., 'tcm:5-12-131074'). Use 'getProcessDefinition' to find available process definitions for the publication."),
        subjectIds: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[^:\s]+)$/))
            .optional()
            .describe("An optional array of item IDs to be included in the workflow. These are the items that will be reviewed or approved."),
        assigneeId: z.string().regex(/^tcm:\d+-\d+-65552$/)
            .optional()
            .describe("The ID of the user to assign the first activity to. Use the 'getUsers' tool to find a user ID."),
        dueDate: z.string().datetime({ message: "Invalid ISO 8601 datetime format." })
            .optional()
            .describe("An optional due date for the first activity in ISO 8601 format (e.g., '2025-12-31T17:00:00Z')."),
    },
    execute: async ({
        publicationId,
        workflowTitle,
        taskTitle,
        processDefinitionId,
        subjectIds,
        assigneeId,
        dueDate
    }: {
        publicationId: string;
        workflowTitle: string;
        taskTitle: string;
        processDefinitionId: string;
        subjectIds?: string[];
        assigneeId?: string;
        dueDate?: string;
    }, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        try {
            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            const escapedPublicationId = publicationId.replace(':', '_');
            const endpoint = `/items/${escapedPublicationId}/startWorkflow`;

            const requestModel = {
                "$type": "StartWorkflowInstruction",
                ProcessInstanceTitle: workflowTitle,
                ActivityTitle: taskTitle,
                ProcessDefinition: toLink(processDefinitionId),
                Subjects: toLinkArray(subjectIds),
                Assignee: toLink(assigneeId),
                DueDate: dueDate,
                WorkflowType: {
                    $type: 'Link',
                    IdRef: 'tcm:0-3-67584',
                    Title: 'Task',
                },
            };

            const response = await authenticatedAxios.post(endpoint, requestModel);

            // A 201 status code indicates the workflow was successfully created.
            if (response.status === 201) {
                const responseData = {
                    type: response.data['$type'],
                    Id: response.data.Id,
                    Message: `Successfully started ${response.data.Id}`,
                };
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(responseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(response);
            }
        } catch (error) {
            return handleAxiosError(error, `Failed to start workflow in publication '${publicationId}'`);
        }
    },
    examples: [
    ]
};