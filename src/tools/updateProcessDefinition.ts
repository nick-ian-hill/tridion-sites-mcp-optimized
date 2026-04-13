import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { activityDefinitionSchema } from "../schemas/activityDefinitionSchema.js";
import { formatForApi } from "../utils/fieldReordering.js";

const updateProcessDefinitionInputProperties = {
    itemId: z.string().regex(/^tcm:\d+-\d+-131074$/, { message: "itemId must be a valid Process Definition URI (e.g., 'tcm:5-1-131074')." }),
    title: z.string().optional().describe("The new title for the Process Definition."),
    description: z.string().optional().describe("The new description for the Process Definition."),
    activityDefinitions: z.array(activityDefinitionSchema).min(1).optional()
        .describe("A complete array of activity definition objects that will replace the existing ones. To modify even a single activity, the entire set must be provided.")
};

const updateProcessDefinitionInputSchema = z.object(updateProcessDefinitionInputProperties);

type UpdateProcessDefinitionInput = z.infer<typeof updateProcessDefinitionInputSchema>;

export const updateProcessDefinition = {
    name: "updateProcessDefinition",
    summary: "Updates an existing Workflow Process Definition, including title, description, and activity sequence.",
    description: `Updates an existing Workflow Process Definition.

This tool can modify the title, description, and the entire sequence of activities within a workflow.

IMPORTANT: When updating 'activityDefinitions', the entire existing set of activities is replaced by the new array you provide. To make a small change, you must provide the complete, modified list of all activities in the desired order.

Shared items ('BluePrintInfo.IsShared' is true) cannot be updated. To modify an inherited Process Definition, you must update the parent item in the BluePrint chain.

For comprehensive details on how to structure activities, write robust C# scripts for automation, dynamically route tasks, and appropriately configure manual 'Decision' activities with automated branch routing, please refer to the extensive documentation in the 'createProcessDefinition' tool.`,
    input: updateProcessDefinitionInputProperties,
    execute: async (params: UpdateProcessDefinitionInput, context: any) => {
        formatForApi(params);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { itemId, ...updates } = params;
        const restItemId = itemId.replace(':', '_');
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        const createErrorResponse = (message: string) => {
            const errorResponse = { $type: 'Error', Message: message };
            return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }], errors: [] };
        };

        try {
            const getItemResponse = await authenticatedAxios.get(`/items/${restItemId}`);
            if (getItemResponse.status !== 200) {
                return handleUnexpectedResponse(getItemResponse);
            }
            let itemToUpdate = getItemResponse.data;

            if (itemToUpdate.BluePrintInfo?.IsShared) {
                return createErrorResponse(`Error: Item ${itemId} is shared and cannot be updated directly. Please update its parent item: ${itemToUpdate.BluePrintInfo.PrimaryBluePrintParentItem.IdRef}`);
            }

            if (updates.title) itemToUpdate.Title = updates.title;
            if (updates.description) itemToUpdate.Description = updates.description;

            if (updates.activityDefinitions) {
                // Validate that all nextActivity titles are defined within the provided array.
                const activityTitles = new Set(updates.activityDefinitions.map(a => a.title));
                for (const ad of updates.activityDefinitions) {
                    if (ad.nextActivities) {
                        for (const nextTitle of ad.nextActivities) {
                            if (!activityTitles.has(nextTitle)) {
                                return createErrorResponse(`Validation Error: Next activity '${nextTitle}' is defined as a transition target but does not exist as an activity title in your provided list.`);
                            }
                        }
                    }
                }

                // Map the user-friendly definition to the API payload structure.
                itemToUpdate.ActivityDefinitions = updates.activityDefinitions.map(ad => {
                    const nextActivityLinks = ad.nextActivities?.map(nextTitle => ({
                        "$type": "Link",
                        "IdRef": "tcm:0-0-0",
                        "Title": nextTitle
                    })) || [];

                    const activityPayload: any = {
                        "$type": "TridionActivityDefinition",
                        "Id": "tcm:0-0-0",
                        "Title": ad.title,
                        "Description": ad.description,
                        "ActivityType": ad.activityType || "Normal",
                        "Script": ad.script?.replace(/\\n/g, '\n'),
                        "ScriptType": ad.script ? "CSharp" : undefined,
                        "NextActivityDefinitions": nextActivityLinks
                    };

                    if (ad.allowOverrideDueDate !== undefined) {
                        activityPayload.AllowOverrideDueDate = ad.allowOverrideDueDate;
                    }

                    if (ad.assigneeId) {
                        activityPayload.Assignee = toLink(ad.assigneeId);
                    }

                    return activityPayload;
                });
            }

            const updateResponse = await authenticatedAxios.put(`/items/${restItemId}`, itemToUpdate);
            if (updateResponse.status !== 200) {
                return handleUnexpectedResponse(updateResponse);
            }
            
            const updatedItem = updateResponse.data;
            const responseData = {
                type: updatedItem['$type'],
                Id: updatedItem.Id,
                Message: `Successfully updated ${updatedItem.Id}`
            };

            return {
                content: [{ type: "text", text: JSON.stringify(responseData, null, 2) }],
            };

        } catch (error) {
            return handleAxiosError(error, `Failed to update Process Definition ${itemId}`);
        }
    },
    examples: [
                        {
                            description: "Update the title of a Process Definition and the description of one of its activities. Ensure automated steps use the System User (tcm:0-3-65552)",
                            payload: `const result = await tools.updateProcessDefinition({
        itemId: "tcm:5-1-131074",
        title: "Task Process (Reviewed)",
        activityDefinitions: [
          {
            "title": "Perform Task",
            "description": "User performs the assigned task. Due date can now be overridden.",
            "assigneeId": "tcm:0-1-65568",
            "allowOverrideDueDate": true,
            "nextActivities": ["Assign to Process Creator"]
          },
          {
            "title": "Assign to Process Creator",
            "assigneeId": "tcm:0-3-65552",
            "description": "Task finished. Automatically routing to the process creator for review.",
            "script": \`ActivityFinishData finishData = new ActivityFinishData();
finishData.Message = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last().FinishMessage;
finishData.NextAssignee = new LinkToTrusteeData();
finishData.NextAssignee.IdRef = ProcessInstance.Creator.IdRef;
SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\`,
            "nextActivities": ["Review Task"]
          },
          {
            "title": "Review Task",
            "activityType": "Decision",
            "description": "Review and approve the task. Finish process or send it back.",
            "nextActivities": ["Decline", "Accept"]
          },
          {
            "title": "Decline",
            "assigneeId": "tcm:0-3-65552",
            "description": "The task was reviewed and will be sent back to the performer.",
            "script": \`string performedTaskActivityDefinitionId = ProcessInstance.Activities.Cast<ActivityInstanceData>().First().ActivityDefinition.IdRef;
ActivityFinishData finishData = new ActivityFinishData();
finishData.Message = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last().FinishMessage;
finishData.NextAssignee = new LinkToTrusteeData();
finishData.NextAssignee.IdRef = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last(activity => activity.ActivityDefinition.IdRef == performedTaskActivityDefinitionId).Owner.IdRef;
SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\`,
            "nextActivities": ["Perform Task"]
          },
          {
            "title": "Accept",
            "assigneeId": "tcm:0-3-65552",
            "description": "The task process is complete.",
            "script": \`ActivityFinishData finishData = new ActivityFinishData();
finishData.Message = "Automatic Activity 'Accept' Finished";
SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\`,
            "nextActivities": []
          }
        ]
    });`
                        },
                        {
                            description: "Add a new 'Abort' step to an existing workflow",
                            payload: `const result = await tools.updateProcessDefinition({
        itemId: "tcm:5-1-131074",
        activityDefinitions: [
          {
            "title": "Perform Task",
            "description": "User performs the assigned task.",
            "assigneeId": "tcm:0-1-65568",
            "allowOverrideDueDate": true,
            "nextActivities": ["Assign to Process Creator"]
          },
          {
            "title": "Assign to Process Creator",
            "assigneeId": "tcm:0-3-65552",
            "description": "Task finished. Automatically routing to the process creator for review.",
            "script": \`ActivityFinishData finishData = new ActivityFinishData();
finishData.Message = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last().FinishMessage;
finishData.NextAssignee = new LinkToTrusteeData();
finishData.NextAssignee.IdRef = ProcessInstance.Creator.IdRef;
SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\`,
            "nextActivities": ["Review Task"]
          },
          {
            "title": "Review Task",
            "activityType": "Decision",
            "description": "Review and approve the task. Finish process, send it back, or abort.",
            "nextActivities": ["Decline", "Accept", "Abort"]
          },
          {
            "title": "Decline",
            "assigneeId": "tcm:0-3-65552",
            "description": "The task was reviewed and will be sent back to the performer.",
            "script": \`string performedTaskActivityDefinitionId = ProcessInstance.Activities.Cast<ActivityInstanceData>().First().ActivityDefinition.IdRef;
ActivityFinishData finishData = new ActivityFinishData();
finishData.Message = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last().FinishMessage;
finishData.NextAssignee = new LinkToTrusteeData();
finishData.NextAssignee.IdRef = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last(activity => activity.ActivityDefinition.IdRef == performedTaskActivityDefinitionId).Owner.IdRef;
SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\`,
            "nextActivities": ["Perform Task"]
          },
          {
            "title": "Accept",
            "assigneeId": "tcm:0-3-65552",
            "description": "The task process is complete.",
            "script": \`ActivityFinishData finishData = new ActivityFinishData();
finishData.Message = "Automatic Activity 'Accept' Finished";
SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\`,
            "nextActivities": []
          },
          {
            "title": "Abort",
            "assigneeId": "tcm:0-3-65552",
            "description": "This new activity aborts and deletes the workflow process.",
            "script": "SessionAwareCoreServiceClient.Delete(ProcessInstance.Id);"
          }
        ]
    });`
                        }
                    ]
};