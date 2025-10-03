import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { activityDefinitionSchema } from "../schemas/activityDefinitionSchema.js";

// Main input properties for the tool.
const createProcessDefinitionInputProperties = {
    title: z.string().nonempty({ message: "Process Definition title cannot be empty." }),
    locationId: z.string().regex(/^tcm:0-\d+-1$/, { message: "locationId must be a valid Publication URI (e.g., 'tcm:0-5-1')." })
        .describe("The TCM URI of the Publication that will contain this Process Definition."),
    description: z.string().optional().describe("An optional description for the Process Definition."),
    activityDefinitions: z.array(activityDefinitionSchema).min(1, { message: "At least one activity definition must be provided." })
        .describe("An array of activity definition objects to be created and linked within the workflow.")
};

const createProcessDefinitionInputSchema = z.object(createProcessDefinitionInputProperties);


export const createProcessDefinition = {
    name: "createProcessDefinition",
    description: `Creates a new Workflow Process Definition, including its full sequence of activities and branches.

This tool simplifies workflow creation by allowing you to define the entire flow in a single JSON structure. You define each step (activity) by giving it a title and specifying the title(s) of the subsequent step(s). The tool handles the underlying process of creating all necessary items and linking them together correctly.

The 'activityDefinitions' parameter accepts an array of objects. Each object defines an activity with properties like:
- title: A unique name for the activity (e.g., "Review Content").
- activityType: Either "Normal" (a single task) or "Decision" (a branch point).
- nextActivities: An array of titles specifying where the workflow goes next. A "Decision" activity can have multiple next activities.
- assigneeId: (Optional) The user or group responsible for the task.
- allowOverrideDueDate: (Optional) A boolean to control if the activity's due date can be changed.
- script: (Optional) A C# script to make the activity automatic.

IMPORTANT: The tool assumes the backend can resolve temporary references during creation. This is a common pattern for creating complex, interlinked items in a single transaction.

Examples:

Example 1: Create a simple, two-step approval workflow.
    const result = await tools.createProcessDefinition({
        title: "Two-Step Approval",
        locationId: "tcm:0-5-1",
        description: "A simple workflow for content creation and approval.",
        activityDefinitions: [
          {
            "title": "Create Content",
            "description": "User creates the initial content.",
            "nextActivities": ["Manager Approval"]
          },
          {
            "title": "Manager Approval",
            "description": "Manager reviews and approves the content to finish the workflow.",
            "nextActivities": []
          }
        ]
    });

Example 2: Create a more complex workflow with a decision point.
    const result = await tools.createProcessDefinition({
        title: "Task Process with Review",
        locationId: "tcm:0-5-1",
        description: "A workflow with a perform step, an automated assignment, a review decision, and accept/decline branches.",
        activityDefinitions: [
          {
            "title": "Perform Task",
            "description": "Perform the specified task.",
            "assigneeId": "tcm:0-1-65568",
            "allowOverrideDueDate": true,
            "nextActivities": ["Assign to Process Creator"]
          },
          {
            "title": "Assign to Process Creator",
            "description": "Task was finished and it will be sent to the process creator.",
            "script": "ActivityFinishData finishData = new ActivityFinishData()\\n{\\n    Message = ProcessInstance.Activities.Last().FinishMessage,\\n    NextAssignee = new LinkToTrusteeData\\n    {\\n        IdRef = ProcessInstance.Creator.IdRef\\n    }\\n};\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
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
            "description": "The task was reviewed and will be sent back to the performer.",
            "script": "string performedTaskActivityDefinitionId = ProcessInstance.Activities.Cast<ActivityInstanceData>().First().ActivityDefinition.IdRef;\\nActivityFinishData finishData = new ActivityFinishData()\\n{\\n    Message = ProcessInstance.Activities.Last().FinishMessage,\\n    NextAssignee = new LinkToTrusteeData\\n    {\\n        IdRef = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last(activity => activity.ActivityDefinition.IdRef == performedTaskActivityDefinitionId).Owner.IdRef\\n    }\\n};\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": ["Perform Task"]
          },
          {
            "title": "Accept",
            "description": "The task process is complete.",
            "script": "ActivityFinishData finishData = new ActivityFinishData()\\n{\\n    Message = \\"Automatic Activity 'Accept' Finished\\"\\n};\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": []
          }
        ]
    });`,
    input: createProcessDefinitionInputProperties,
    execute: async (args: z.infer<typeof createProcessDefinitionInputSchema>, context: any) => {
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { title, locationId, description, activityDefinitions } = args;
        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            // Perform cross-activity validation to ensure all nextActivities titles exist.
            const activityTitles = new Set(activityDefinitions.map(a => a.title));
            const allNextActivities = new Set(activityDefinitions.flatMap(a => a.nextActivities));
            for (const nextTitle of allNextActivities) {
                if (!activityTitles.has(nextTitle)) {
                    return { content: [{ type: "text", text: `Error: Next activity '${nextTitle}' is defined as a transition target but does not exist as an activity.` }] };
                }
            }

            console.log(`[createProcessDefinition] Fetching default model for ProcessDefinition from container '${locationId}'...`);
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/ProcessDefinition', {
                params: { containerId: locationId }
            });

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;

            // Build the final payload with the embedded activity definitions and temporary links
            payload.Title = title;
            payload.Description = description;
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

            payload.ActivityDefinitions = activityDefinitions.map(ad => {
                const nextActivityLinks = ad.nextActivities.map(nextTitle => ({
                    "$type": "Link",
                    "IdRef": "tcm:0-0-0",
                    "Title": nextTitle
                }));

                const activityPayload: any = {
                    "$type": "TridionActivityDefinition",
                    "Id": "tcm:0-0-0",
                    "Title": ad.title,
                    "Description": ad.description,
                    "ActivityType": ad.activityType,
                    "Script": ad.script?.replace(/\\n/g, '\n'),
                    "ScriptType": ad.scriptType,
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

            console.log(`[createProcessDefinition] Final payload constructed. Posting to /items...`);
            console.log(JSON.stringify(payload, null, 2));

            // Post the single, complete payload to create the item atomically
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully created Process Definition with ID ${createResponse.data.Id}.\n\n${JSON.stringify(createResponse.data, null, 2)}`
                        }
                    ],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }

        } catch (error) {
            return handleAxiosError(error, "Failed to create Process Definition");
        }
    }
};