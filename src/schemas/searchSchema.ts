import { z } from "zod";

const SchemaFieldFilterValidation = z.object({
  name: z.string().describe("The 'baseName' of the schema field to filter on."),
  value: z.union([z.string(), z.number()]).describe("The value of the field to search for.")
});

const SchemaFilterValidation = z.object({
  schemaUri: z.string().regex(/^tcm:\d+-\d+-8?$/),
  fieldFilter: SchemaFieldFilterValidation.optional().describe("An optional filter for a specific field within the schema.")
});

export const SearchQueryValidation = z.object({
  // --- Core Search Criteria ---
  FullTextQuery: z.string().optional().describe("A full-text query string to search for. Supports query syntax like +, -, &&, ||, *, etc."),
  Title: z.string().optional().describe("A string to search for in item titles. This is treated as a phrase and does not support wildcards."),
  Description: z.string().optional().describe("A string to search for in the item's description field."),
  ItemTypes: z.array(z.enum([
    "BusinessProcessType", "Category", "Component", "ComponentTemplate", "Folder",
    "Keyword", "Page", "PageTemplate", "ProcessDefinition", "Publication", "Schema",
    "StructureGroup", "TargetGroup", "TemplateBuildingBlock", "VirtualFolder"
  ])).optional().describe("An array of item types to limit the search results to. If asked to search for a 'Bundle' or 'SearchFolder', use the 'VirtualFolder' type and then review the 'type' property of any returned items. To find 'MultimediaComponents', search for 'Component' and then review the 'ComponentType' property."),

  // --- Location and Scope ---
  SearchIn: z.string().regex(/^(tcm:\d+-\d+-[124]|ecl:[a-zA-Z0-9-]+)$/).optional().describe("The unique TCM URI of the publication or folder to search within. MUST be provided as a string. Required when using the 'BasedOnSchemas', 'UsedKeywords', 'ProcessDefinition', or 'ActivityDefinition' query parameters."),
  SearchInSubtree: z.boolean().default(true).optional().describe("When true, searches recursively in the publication/folder specified in SearchIn. Defaults to true."),

  // --- Schema and Keyword Criteria ---
  BasedOnSchemas: z.array(SchemaFilterValidation).optional().describe("An array of Schema filters. Each filter can specify a Schema URI and an optional field-level filter. You must specify a value for 'SearchIn' when using this parameter."),
  UsedKeywords: z.array(z.string().regex(/^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/)).optional().describe("An array of Keyword TCM URIs. Only items classified with these keywords will be returned. You must specify a value for 'SearchIn' when using this parameter."),

  // --- Date and Modification Criteria ---
  LastModifiedAfter: z.string().datetime().optional().describe("Filters items last modified after this date (ISO 8601 format, e.g., '2023-10-27T10:00:00Z')."),
  LastModifiedBefore: z.string().datetime().optional().describe("Filters items last modified before the specified date (ISO 8601 format, e.g., '2023-10-28T10:00:00Z'). Use this when asked to find items “not modified after” a certain date, since such items must have been modified before that date."),
  ModifiedInLastDays: z.number().int().optional().describe("Filters items modified in the last specified number of days."),
  ModifiedInLastMonths: z.number().int().optional().describe("Filters items modified in the last specified number of months."),

  // --- User and Lock Criteria ---
  Author: z.string().regex(/^tcm:0-\d+-65552$/).optional().describe("The TCM URI of the author (User) to search for."),
  LockUser: z.string().regex(/^tcm:0-\d+-65552$/).optional().describe("The TCM URI of the user that must hold the lock on an item."),
  LockType: z.array(z.enum(["None", "CheckedOut", "Permanent", "InWorkflow"]))
    .optional()
    .describe("Filters items by their lock state. Supported values are: [\"None\"], [\"CheckedOut\"], and [\"CheckedOut\", \"Permanent\", \"InWorkflow\"]")
    .refine(
        (val) => {
            if (!val) return true;

            const arrayEquals = (a: string[], b: string[]) => {
                if (a.length !== b.length) return false;
                const sortedA = [...a].sort();
                const sortedB = [...b].sort();
                return sortedA.every((v, i) => v === sortedB[i]);
            };

            const validCombinations = [
                ["None"],
                ["CheckedOut"],
                ["CheckedOut", "Permanent", "InWorkflow"]
            ];

            return validCombinations.some(combo => arrayEquals(val, combo));
        },
        {
            message: `Invalid LockType combination. The only supported values are ["None"], ["CheckedOut"], or ["CheckedOut", "Permanent", "InWorkflow"].`
        }
    ),

  // --- Publishing and Blueprinting ---
  IsPublished: z.boolean().optional().describe("Filters items based on their published state. True for published, false for unpublished."),
  BlueprintStatus: z.enum(["Local", "Shared", "Localized"]).optional().describe("Filter items by Blueprint status."),
  FromRepository: z.string().regex(/^tcm:0-\d+-1$/).optional().describe("If 'Shared' was selected as the BlueprintStatus, this value is the TCM URI of the Repository (Publication) from which the item is shared."),

  // --- Case Sensitivity ---
  IsTitleCaseSensitive: z.boolean().optional().describe("When true, the search on the 'Title' field is case-sensitive."),
  IsDescriptionCaseSensitive: z.boolean().optional().describe("When true, the search on the 'Description' field is case-sensitive."),

  // --- Workflow ---
  ActivityDefinition: z.string().regex(/^tcm:\d+-\d+-131088$/).optional().describe("The TCM URI of an Activity Definition an item must be associated with. You must specify a value for 'SearchIn' when using this parameter."),
  ProcessDefinition: z.string().regex(/^tcm:\d+-\d+-131074$/).optional().describe("The TCM URI of a Process Definition an item must be associated with. You must specify a value for 'SearchIn' when using this parameter."),
})
.refine(
    (data) => {
        const needsSearchIn = (data.BasedOnSchemas?.length ?? 0) > 0 ||
                            (data.UsedKeywords?.length ?? 0) > 0 ||
                            !!data.ProcessDefinition ||
                            !!data.ActivityDefinition;

        return !needsSearchIn || !!data.SearchIn;
    },
    {
        message: "The 'SearchIn' parameter is required when using 'BasedOnSchemas', 'UsedKeywords', 'ProcessDefinition', or 'ActivityDefinition'.",
    }
);

export type SearchQuery = z.infer<typeof SearchQueryValidation>;