import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";

// Schema for a single activity definition as provided by the user.
const activityDefinitionInputSchema = z.object({
    title: z.string().nonempty({ message: "Activity title cannot be empty." }),
    description: z.string().optional(),
    activityType: z.enum(["Normal", "Decision"]).default("Normal")
        .describe("The type of the activity. 'Normal' for a standard task, 'Decision' for a point where the workflow can branch."),
    assigneeId: z.string().regex(/^(tcm:0-\d+-(65552|65568)|tcm:0-0-0)$/).optional()
        .describe("Optional TCM URI of the User or Group to assign the activity to (e.g., 'tcm:0-12-65552'). Use 'getUsers' or 'getGroups' to find an ID. If omitted, the system default is used (e.g., the 'Everyone' group for the first activity, or the previous performer for subsequent activities)."),
    script: z.string().optional()
        .describe("Optional C# script to make this an automatic activity. The script is executed when the activity starts."),
    scriptType: z.enum(["CSharp"]).default("CSharp")
        .describe("The scripting language used. Currently, only 'CSharp' is supported."),
    nextActivities: z.array(z.string().regex(/^tcm:\d+-\d+-131088$/)).default([])
        .describe("An array of titles of the next activities. For a 'Decision' activity, this can contain multiple titles, creating branches. For a 'Normal' activity, it should contain zero or one title.")
}).refine(data => data.activityType === 'Decision' || data.nextActivities.length <= 1, {
    message: "A 'Normal' activity cannot have more than one next activity.",
});

type ActivityDefinitionInput = z.infer<typeof activityDefinitionInputSchema>;

// Main input properties for the tool.
const createProcessDefinitionInputProperties = {
    title: z.string().nonempty({ message: "Process Definition title cannot be empty." }),
    locationId: z.string().regex(/^tcm:0-\d+-1$/, { message: "locationId must be a valid Publication URI (e.g., 'tcm:0-5-1')." })
        .describe("The TCM URI of the Publication that will contain this Process Definition. Use 'getPublications' to find the correct ID."),
    description: z.string().optional().describe("An optional description for the Process Definition."),
    activityDefinitions: z.string().describe("A JSON string representing an array of activity definitions that constitute the workflow. The first activity in the array will be the starting point of the workflow.")
};

const createProcessDefinitionInputSchema = z.object(createProcessDefinitionInputProperties);


export const createProcessDefinition = {
    name: "createProcessDefinition",
    description: `Creates a new Workflow Process Definition, including its full sequence of activities and branches.

This tool simplifies workflow creation by allowing you to define the entire flow in a single JSON structure. You define each step (activity) by giving it a title and specifying the title(s) of the subsequent step(s). The tool handles the underlying process of creating all necessary items and linking them together correctly.

The 'activityDefinitions' parameter accepts a JSON string which is an array of objects. Each object defines an activity with properties like:
- title: A unique name for the activity (e.g., "Review Content").
- activityType: Either "Normal" (a single task) or "Decision" (a branch point).
- nextActivities: An array of titles specifying where the workflow goes next. A "Decision" activity can have multiple next activities.
- assigneeId: (Optional) The user or group responsible for the task.
- script: (Optional) A C# script to make the activity automatic.

IMPORTANT: The tool assumes the backend can resolve temporary references during creation. This is a common pattern for creating complex, interlinked items in a single transaction.

Examples:

Example 1: Create a simple, two-step approval workflow.
    const twoStepWorkflow = JSON.stringify([
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
    ]);
    const result = await tools.createProcessDefinition({
        title: "Two-Step Approval",
        locationId: "tcm:0-5-1",
        description: "A simple workflow for content creation and approval.",
        activityDefinitions: twoStepWorkflow
    });

Example 2: Create a more complex workflow with a decision point, mirroring the provided documentation example.
    const complexWorkflow = JSON.stringify([
      {
        "title": "Perform Task",
        "description": "Perform the specified task.",
        "assigneeId": "tcm:0-1-65568",
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
    ]);
    const result = await tools.createProcessDefinition({
        title: "Task Process with Review",
        locationId: "tcm:0-5-1",
        description: "A workflow with a perform step, an automated assignment, a review decision, and accept/decline branches.",
        activityDefinitions: complexWorkflow
    });`,

    input: createProcessDefinitionInputProperties,
    execute: async (args: z.infer<typeof createProcessDefinitionInputSchema>, context: any) => {
        console.log(`[createProcessDefinition] Starting execution with args:`, args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const { title, locationId, description, activityDefinitions: activityDefinitionsJson } = args;

        try {
            // 1. Parse and validate the activity definitions JSON
            console.log(`[createProcessDefinition] Parsing 'activityDefinitions' JSON string...`);
            let parsedActivities: ActivityDefinitionInput[];
            try {
                parsedActivities = JSON.parse(activityDefinitionsJson);
                console.log(`[createProcessDefinition] Successfully parsed 'activityDefinitions'.`);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`[createProcessDefinition] JSON parsing failed: ${errorMessage}`);
                return { content: [{ type: "text", text: `Error: The 'activityDefinitions' parameter is not a valid JSON string. Details: ${errorMessage}` }] };
            }

            console.log(`[createProcessDefinition] Validating activity definitions structure...`);
            const validationResult = z.array(activityDefinitionInputSchema).safeParse(parsedActivities);
            if (!validationResult.success) {
                const formattedError = JSON.stringify(validationResult.error.format(), null, 2);
                console.error(`[createProcessDefinition] Zod validation failed:`, formattedError);
                return { content: [{ type: "text", text: `Error: Invalid activity definitions structure. Details: ${formattedError}` }] };
            }
            const activities = validationResult.data;
            console.log(`[createProcessDefinition] Zod validation successful.`);

            if (activities.length === 0) {
                return { content: [{ type: "text", text: "Error: At least one activity definition must be provided." }] };
            }

            // 2. Perform cross-activity validation
            console.log(`[createProcessDefinition] Performing cross-activity validation (unique titles, link integrity)...`);
            const activityTitles = new Set(activities.map(a => a.title));
            if (activityTitles.size !== activities.length) {
                return { content: [{ type: "text", text: "Error: Activity titles must be unique." }] };
            }

            const allNextActivities = new Set(activities.flatMap(a => a.nextActivities));
            for (const nextTitle of allNextActivities) {
                if (!activityTitles.has(nextTitle)) {
                    return { content: [{ type: "text", text: `Error: Next activity '${nextTitle}' is defined as a transition target but does not exist as an activity.` }] };
                }
            }
            console.log(`[createProcessDefinition] Cross-activity validation successful.`);

            // 3. Prepare payload using temporary IDs for linking
            const titleToTempId = new Map(activities.map((act, index) => [act.title, `temp:${index}`]));

            const authenticatedAxios = createAuthenticatedAxios(userSessionId);
            console.log(`[createProcessDefinition] Fetching default model for ProcessDefinition from container '${locationId}'...`);
            const defaultModelResponse = await authenticatedAxios.get('/item/defaultModel/ProcessDefinition', {
                params: { containerId: locationId }
            });

            if (defaultModelResponse.status !== 200) {
                return handleUnexpectedResponse(defaultModelResponse);
            }
            const payload = defaultModelResponse.data;
            console.log(`[createProcessDefinition] Successfully fetched default model.`);

            // 4. Build the final payload
            payload.Title = title;
            if (description) {
                payload.Description = description;
            }
            
            payload.ActivityDefinitions = activities.map(act => {
                const tempId = titleToTempId.get(act.title)!;

                const nextActivityLinks = (act.nextActivities || []).map(nextTitle => ({
                    "$type": "Link",
                    "IdRef": titleToTempId.get(nextTitle)!,
                    "Title": nextTitle
                }));

                const activityPayload: any = {
                    "$type": "TridionActivityDefinition",
                    "Id": tempId,
                    "Title": act.title,
                    "Description": act.description,
                    "ActivityType": act.activityType,
                    "Script": act.script,
                    "ScriptType": act.scriptType,
                    "NextActivityDefinitions": nextActivityLinks
                };
                
                if (act.assigneeId) {
                    activityPayload.Assignee = toLink(act.assigneeId);
                }

                return activityPayload;
            });
            
            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }
            
            console.log(`[createProcessDefinition] Final payload constructed. Posting to /items...`);
            console.log(JSON.stringify(payload, null, 2));

            // 5. Post the payload to create the Process Definition and all its activities
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                console.log(`[createProcessDefinition] API call successful. Process Definition created with ID: ${createResponse.data.Id}`);
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