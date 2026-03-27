import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { activityDefinitionSchema } from "../schemas/activityDefinitionSchema.js";
import { formatForAgent, formatForApi } from "../utils/fieldReordering.js";

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

### Predefined Script Variables (The Sandbox)
Inline C# scripts execute within a predefined method and have automatic access to the following globally scoped variables. You do NOT need to declare or instantiate these:
- **SessionAwareCoreServiceClient** (ISessionAwareCoreService): The primary client for CMS interactions (Publish, FinishActivity, SuspendActivity, etc.).
- **CurrentActivityInstance** (ActivityInstanceData): Represents the current executing step (use \`.Id\` for finishing/suspending).
- **ProcessInstance** (ProcessInstanceData): Represents the entire workflow. Use \`.Variables\` for state management, \`.Subjects\` for the items in workflow, and \`.Activities\` for history.
- **ResumeBookmark** (string): Used to evaluate if a script is starting fresh or waking up from a suspended state.
- **Logger**: A utility for debugging. Use \`Logger.Information("msg")\`, \`Logger.Warning("msg")\`, or \`Logger.Verbose("msg")\` to write to the Windows Event Log.
- **CoreServiceBatchClient** (ICoreServiceBatch): Used for executing commands on a large set of items simultaneously.
- **StreamDownloadClient** / **StreamUploadClient**: Clients for handling file streams directly within the CMS.

### Core Concepts: The "Automated Activity" Pattern
To make an activity "automated", define it as a "Normal" activity type and provide a C# script in the 'script' property. 
- **Assignee Best Practice**: Always assign automated activities to the System User (assigneeId: "tcm:0-3-65552"). This prevents the workflow from "hanging" or appearing in manual worklists.
- **Finishing**: Most scripts MUST end by programmatically finishing the activity using 'SessionAwareCoreServiceClient.FinishActivity(...)'.
- **Referenced Assemblies vs. Namespaces**: 
  - **Rule 1 (Namespaces)**: Most 'Tridion.ContentManager.CoreService.Client' types (like 'ActivityFinishData', 'PublishInstructionData', 'LinkToTrusteeData') are implicitly in scope and do NOT need full qualification. The confirmed exception is 'PublishPriority', which MUST always be fully qualified as 'Tridion.ContentManager.CoreService.Client.PublishPriority' due to naming collisions.
  - **Rule 2 (LINQ & Type Inference)**: The inline compiler struggles with implicit type inference. If you use LINQ on collections like 'ProcessInstance.Subjects' or 'ProcessInstance.Activities', you MUST explicitly cast the collection first (e.g., 'ProcessInstance.Activities.Cast<ActivityInstanceData>().First()'). If you do not want to cast, use standard procedural 'for'/'foreach' loops instead.
- **Formatting**: Ensure your C# code is correctly formatted as a single string, with newlines represented as '\\n' and quotes escaped as '\\"'.

### State Management (Passing Variables)
Use \`ProcessInstance.Variables\` to pass state/data between activities. All values added must be strings or cast to strings.
- **Set/Update a variable (Idempotent):** \`ProcessInstance.Variables["MyKey"] = "MyValue";\`
- **Get a variable:** \`string myVal = ProcessInstance.Variables["MyKey"];\`
- **Check existence:** \`if (!ProcessInstance.Variables.ContainsKey("SpecificActivityFinished")) { ... }\`
- **Permanent Storage (Application Data):** For permanent key-value storage attached directly to CMS items rather than the workflow instance, use the \`SessionAwareCoreServiceClient.SaveApplicationData\` and \`ReadApplicationData\` methods.

### Advanced Scripting: Directives and Methods
If you need to define a helper method or import a specific namespace, you MUST use Tridion script directives at the very top of your script.
- **Assembly Reference:** \`<%@Assembly Name="System.ServiceModel, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"%>\`
- **Namespace Import:** \`<%@ Import Namespace="System.ServiceModel"%>\`
- **Method Definition:** You must wrap custom methods in \`<%! ... %>\` blocks.
  Example: \`<%! private string FinishedMessage() { return "Finished"; } %>\`

### Best Practices for Decision Routing
**Do not automate "Decision" activities directly.** Automating a Decision activity is highly discouraged because 'FinishActivity' requires a 'nextActivityDefinitionId' to know which branch to take. Since these IDs are generated dynamically during process creation, they cannot be safely hardcoded.
**Recommendation**: After a manual Decision activity that routes the user (e.g., Approve or Reject), it is highly desirable that the actual routing/processing is performed automatically. To achieve this, make the branches (the immediate next steps) "Normal" automated activities assigned to the System User. These automated branch activities can execute necessary logic (like setting variables or publishing) and then automatically finish to push the workflow to the next real stage.

### Deep Dive: Robust Automated Publishing
Scripts must handle several quirks when publishing:
1. **Version Stripping**: Item IDs in workflow packages often contain version suffixes (e.g., "-v12"). The Publish method requires standard IDs without these suffixes.
2. **Null Safety**: Always verify that the Publish call returned a valid transaction array before attempting to access its members.
3. **Unpublishing (Case Sensitivity & Signatures)**: To unpublish items, use the \`UnPublish\` method (capital 'P'). Note that \`UnPublish\` mirrors the \`Publish\` signature (taking item IDs and target URIs), rather than taking a transaction ID.

### Dynamic Routing Patterns
You can use ProcessInstance history to dynamically route workflows.
- **Pattern A (Return to Creator)**: Send a task back to the workflow initiator.
  \`NextAssignee = new LinkToTrusteeData { IdRef = ProcessInstance.Creator.IdRef }\`
- **Pattern B (Return to Last Performer)**: Trace history to send a task back to the specific person who completed an earlier step. Use LINQ on \`ProcessInstance.Activities\`.

### Troubleshooting
- **No Object Initializers:** The inline compiler does not support C# object initializers. You MUST instantiate objects and assign properties on separate lines.
  *Bad:* \`ActivityFinishData data = new ActivityFinishData { Message = "Done" };\`
  *Good:* \`ActivityFinishData data = new ActivityFinishData(); data.Message = "Done";\`
- **Error: "A namespace cannot directly contain members such as fields or methods"**: You attempted to define a C# method inside the script but forgot to wrap it in the \`<%! ... %>\` directive. All custom methods must be enclosed in these specific tags.
- **Error: "Activity 'X' has invalid script" (400 Bad Request)**: This is a generic compilation error. It almost always means one of four things:
  1. You failed to fully qualify an ambiguous type (like \`Tridion.ContentManager.CoreService.Client.PublishPriority\`).
  2. You used an object initializer instead of separating instantiation and assignment.
  3. You used a LINQ extension method without explicitly casting the collection first (e.g., missing '.Cast<TargetType>()').
  4. You have a standard C# syntax error (missing semicolon, mismatched braces). 
  *Fix:* Revert to procedural C# loops, fully qualified exceptions, and sequential property assignments.
- **Error: "Next activity 'X' does not exist"**: Ensure the exact string in 'nextActivities' matches the 'title' property of another activity defined in the same array.
- **UI Error: "Not found" on an automated step**: This usually indicates the C# script crashed. Add a try-catch block to log errors to \`ProcessInstance.Variables["Error"]\` for easier debugging.
- **Large Debug Output:** If you need to output logs that are too large for standard variables, use the \`((char)34).ToString()\` + folder metadata technique to dump the payload into a temporary folder's metadata.

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

Example 2: Create a complex workflow using Best Practice Decision Routing (Manual Decision -> Automated Branches).
*Note the strict avoidance of Object Initializers and the explicit LINQ casting.*
    const result = await tools.createProcessDefinition({
        title: "Task Process with Review",
        locationId: "tcm:0-5-1",
        description: "A workflow with a perform step, an automated assignment, a review decision, and automated accept/decline branches.",
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
            "assigneeId": "tcm:0-3-65552",
            "description": "Task was finished and it will be sent to the process creator.",
            "script": "ActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last().FinishMessage;\\nfinishData.NextAssignee = new LinkToTrusteeData();\\nfinishData.NextAssignee.IdRef = ProcessInstance.Creator.IdRef;\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": ["Review Task"]
          },
          {
            "title": "Review Task",
            "activityType": "Decision",
            "description": "Manual review. Choose to Accept or Decline.",
            "nextActivities": ["Decline", "Accept"]
          },
          {
            "title": "Decline",
            "assigneeId": "tcm:0-3-65552",
            "description": "Automated routing: Sends task back to the original performer.",
            "script": "string performedTaskActivityDefinitionId = ProcessInstance.Activities.Cast<ActivityInstanceData>().First().ActivityDefinition.IdRef;\\nActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last().FinishMessage;\\nfinishData.NextAssignee = new LinkToTrusteeData();\\nfinishData.NextAssignee.IdRef = ProcessInstance.Activities.Cast<ActivityInstanceData>().Last(activity => activity.ActivityDefinition.IdRef == performedTaskActivityDefinitionId).Owner.IdRef;\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": ["Perform Task"]
          },
          {
            "title": "Accept",
            "assigneeId": "tcm:0-3-65552",
            "description": "Automated routing: The task process is complete.",
            "script": "ActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = \\"Automatic Activity 'Accept' Finished\\";\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
            "nextActivities": []
          }
        ]
    });

Example 3: Create a workflow with an auto-publish script.
    const result = await tools.createProcessDefinition({
        title: "Auto-Publish Workflow",
        locationId: "tcm:0-5-1",
        description: "A workflow with a review decision that automatically publishes items upon approval.",
        activityDefinitions: [
            {
                "title": "Review for Publish",
                "activityType": "Decision",
                "description": "Review the item and decide whether to approve and publish, or reject.",
                "nextActivities": ["Reject", "Approve and Publish"]
            },
            {
                "title": "Reject",
                "assigneeId": "tcm:0-3-65552",
                "description": "Automated rejection routing.",
                "script": "ActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = \\"Item rejected for publishing.\\";\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
                "nextActivities": []
            },
            {
                "title": "Approve and Publish",
                "assigneeId": "tcm:0-3-65552",
                "description": "This automated activity safely publishes the items.",
                "script": "if (ProcessInstance.Subjects != null && ProcessInstance.Subjects.Length > 0)\\n{\\n    string[] itemIds = new string[ProcessInstance.Subjects.Length];\\n    for (int i = 0; i < ProcessInstance.Subjects.Length; i++)\\n    {\\n        string id = ProcessInstance.Subjects[i].IdRef;\\n        int vIndex = id.LastIndexOf(\\"-v\\");\\n        itemIds[i] = (vIndex > -1) ? id.Substring(0, vIndex) : id;\\n    }\\n    PublishInstructionData instruction = new PublishInstructionData();\\n    instruction.ResolveInstruction = new ResolveInstructionData();\\n    instruction.ResolveInstruction.IncludeComponentLinks = true;\\n    instruction.ResolveInstruction.IncludeDynamicVersion = true;\\n    instruction.RenderInstruction = new RenderInstructionData();\\n    SessionAwareCoreServiceClient.Publish(itemIds, instruction, new string[] { \\"tcm:0-2-65538\\" }, Tridion.ContentManager.CoreService.Client.PublishPriority.Normal, null);\\n}\\nActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = \\"Automated publishing initiated.\\";\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);"
            }
        ]
    });

Example 4: Create a workflow with an automated activity that aborts the entire process.
    const result = await tools.createProcessDefinition({
        title: "Workflow with Abort Step",
        locationId: "tcm:0-5-1",
        description: "A workflow with a review step and an explicit abort option.",
        activityDefinitions: [
            {
                "title": "Review",
                "activityType": "Decision",
                "description": "Review the item and decide to approve or abort.",
                "nextActivities": ["Approve", "Abort Process"]
            },
            {
                "title": "Approve",
                "description": "The item is approved and the workflow finishes.",
                "nextActivities": []
            },
            {
                "title": "Abort Process",
                "assigneeId": "tcm:0-3-65552",
                "description": "This activity automatically aborts and deletes the entire workflow process.",
                "script": "SessionAwareCoreServiceClient.Delete(ProcessInstance.Id);"
            }
        ]
    });

Example 5: Create a workflow with a timed delay. The script suspends the activity for 24 hours.
    const result = await tools.createProcessDefinition({
        title: "Delayed Notification Workflow",
        locationId: "tcm:0-5-1",
        description: "A workflow that waits for one day before proceeding.",
        activityDefinitions: [
            {
                "title": "Initial Step",
                "description": "Start the process.",
                "nextActivities": ["Wait One Day"]
            },
            {
                "title": "Wait One Day",
                "assigneeId": "tcm:0-3-65552",
                "description": "This automated activity pauses the workflow for 24 hours.",
                "script": "if (string.IsNullOrEmpty(ResumeBookmark))\\n{\\n    SessionAwareCoreServiceClient.SuspendActivity(CurrentActivityInstance.Id, \\"Suspending for 24 hours\\", System.DateTime.Now.AddDays(1), \\"ResumeAfterDelay\\", null);\\n}\\nelse if (ResumeBookmark == \\"ResumeAfterDelay\\")\\n{\\n    ActivityFinishData finishData = new ActivityFinishData();\\n    finishData.Message = \\"Resumed after 24 hour delay.\\";\\n    SessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);\\n}"
            }
        ]
    });

Example 6: Passing variables between activities using indexers.
    const result = await tools.createProcessDefinition({
        title: "Variable Passing Workflow",
        locationId: "tcm:0-5-1",
        description: "Demonstrates storing a state value in one step and reading it in another.",
        activityDefinitions: [
            {
                "title": "Save State",
                "assigneeId": "tcm:0-3-65552",
                "description": "Saves a custom string to the Process Variables.",
                "script": "ProcessInstance.Variables[\\"MyCustomKey\\"] = \\"ActionCompleted\\";\\nActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = \\"Saved variable\\";\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
                "nextActivities": ["Read State"]
            },
            {
                "title": "Read State",
                "assigneeId": "tcm:0-3-65552",
                "description": "Retrieves the variable and uses it.",
                "script": "string storedVal = ProcessInstance.Variables[\\"MyCustomKey\\"];\\nLogger.Information(\\"Retrieved state: \\" + storedVal);\\nActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = \\"Read variable: \\" + storedVal;\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
                "nextActivities": []
            }
        ]
    });

Example 7: Using Script Directives and Defining Methods.
    const result = await tools.createProcessDefinition({
        title: "Workflow with Custom Methods",
        locationId: "tcm:0-5-1",
        description: "Demonstrates using directives to import namespaces and define custom methods.",
        activityDefinitions: [
            {
                "title": "Log and Finish",
                "assigneeId": "tcm:0-3-65552",
                "description": "Uses a custom method to generate the finish message.",
                "script": "<%@ Import Namespace=\\"System.ServiceModel\\"%>\\n<%!\\n    private string FinishedMessage()\\n    {\\n        return \\"Finished \\" + BasicHttpSecurityMode.Message.ToString();\\n    }\\n%>\\nLogger.Verbose(\\"Executing C# script\\");\\nActivityFinishData finishData = new ActivityFinishData();\\nfinishData.Message = FinishedMessage();\\nSessionAwareCoreServiceClient.FinishActivity(CurrentActivityInstance.Id, finishData, null);",
                "nextActivities": []
            }
        ]
    });`,
    input: createProcessDefinitionInputProperties,
    execute: async (args: z.infer<typeof createProcessDefinitionInputSchema>, context: any) => {
        formatForApi(args);
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
                    const errorResponse = {
                        $type: 'Error',
                        Message: `Error: Next activity '${nextTitle}' is defined as a transition target but does not exist as an activity.`
                    };
                    return { content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }] };
                }
            }

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
                const nextActivityLinks = (ad.nextActivities || []).map(nextTitle => ({
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

            // Post the single, complete payload to create the item atomically
            const createResponse = await authenticatedAxios.post('/items', payload);

            if (createResponse.status === 201) {
                const responseData = {
                    $type: createResponse.data['$type'],
                    Id: createResponse.data.Id,
                    Message: `Successfully created ${createResponse.data.Id}`
                };
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(formattedResponseData, null, 2)
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