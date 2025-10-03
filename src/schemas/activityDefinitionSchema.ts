import { z } from "zod";

export const activityDefinitionSchema = z.object({
    title: z.string().nonempty({ message: "Activity title cannot be empty." }),
    description: z.string().optional(),
    activityType: z.enum(["Normal", "Decision"]).default("Normal")
        .describe("The type of the activity. 'Normal' for a standard task, 'Decision' for a point where the workflow can branch."),
    assigneeId: z.string().regex(/^(tcm:0-\d+-(65552|65568)|tcm:0-0-0)$/).optional()
        .describe("Optional TCM URI of the User or Group to assign the activity to."),
    allowOverrideDueDate: z.boolean().default(true).optional()
        .describe("Set to true to allow the due date for this activity to be changed during the workflow process."),
    script: z.string().optional()
        .describe("Optional C# script to make this an automatic activity. The script is executed when the activity starts."),
    scriptType: z.enum(["CSharp"]).default("CSharp")
        .describe("The scripting language used. Currently, only 'CSharp' is supported."),
    nextActivities: z.array(z.string()).default([])
        .describe("An array of titles for the next activities. These titles must match the 'title' of other activities defined in this same request.")
}).refine(data => data.activityType === 'Decision' || data.nextActivities.length <= 1, {
    message: "A 'Normal' activity cannot have more than one next activity.",
});