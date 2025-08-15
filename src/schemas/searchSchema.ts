import { z } from "zod";

export const SearchQueryValidation = z.object({
  // --- Core Search Criteria ---
  FullTextQuery: z.string().optional().describe("A full-text query string to search for. Supports query syntax like +, -, &&, ||, *, etc."),
  Title: z.string().optional().describe("A string to search for in item titles. This is treated as a phrase and does not support wildcards."),
  Description: z.string().optional().describe("A string to search for in the item's description field."),
  ItemTypes: z.array(z.enum([
    "Folder", "Component", "Page", "Schema", "ComponentTemplate", "PageTemplate",
    "MultimediaType", "Category", "Keyword", "User", "Group", "Publication",
    "TargetGroup", "TemplateBuildingBlock", "SearchFolder", "StructureGroup",
  ])).optional().describe("An array of item types to limit the search results to."),

  // --- Location and Scope ---
  SearchIn: z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/).optional().describe("The unique TCM URI of the publication or folder to search within. MUST be provided as a string."),
  SearchInSubtree: z.boolean().default(true).optional().describe("When true, searches recursively in the publication/folder specified in SearchIn. Defaults to true."),

  // --- Schema and Keyword Criteria ---
  BasedOnSchemas: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of Schema TCM URIs. Only items based on these schemas will be returned."),
  UsedKeywords: z.array(z.string().regex(/^(tcm|ecl):\d+-\d+(-\d+)?$/)).optional().describe("An array of Keyword TCM URIs. Only items classified with these keywords will be returned."),

  // --- Date and Modification Criteria ---
  LastModifiedAfter: z.string().datetime().optional().describe("Filters items last modified after this date (ISO 8601 format, e.g., '2023-10-27T10:00:00Z')."),
  LastModifiedBefore: z.string().datetime().optional().describe("Filters items last modified before the specified date (ISO 8601 format, e.g., '2023-10-28T10:00:00Z'). Use this when asked to find items “not modified after” a certain date, since such items must have been modified before that date."),
  ModifiedInLastDays: z.number().int().optional().describe("Filters items modified in the last specified number of days."),
  ModifiedInLastMonths: z.number().int().optional().describe("Filters items modified in the last specified number of months."),

  // --- User and Lock Criteria ---
  Author: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of the author (User) to search for."),
  LockUser: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of the user that must hold the lock on an item."),
  LockType: z.array(z.enum(["None", "CheckedOut", "Permanent", "InWorkflow"])).optional().describe("Filters items by their lock state."),

  // --- Publishing and Blueprinting ---
  IsPublished: z.boolean().optional().describe("Filters items based on their published state. True for published, false for unpublished."),
  BlueprintStatus: z.enum(["Primary", "Shared", "Localized"]).optional().describe("Filter items by Blueprint status."),
  FromRepository: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("If 'Shared' was selected as the BlueprintStatus, this value is the TCM URI of the Repository (Publication) from which the item is shared."),

  // --- Case Sensitivity ---
  IsTitleCaseSensitive: z.boolean().optional().describe("When true, the search on the 'Title' field is case-sensitive."),
  IsDescriptionCaseSensitive: z.boolean().optional().describe("When true, the search on the 'Description' field is case-sensitive."),

  // --- Workflow ---
  ActivityDefinition: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of an Activity Definition an item must be associated with."),
  ProcessDefinition: z.string().regex(/^tcm:\d+-\d+-\d+$/).optional().describe("The TCM URI of a Process Definition an item must be associated with."),
});

export type SearchQuery = z.infer<typeof SearchQueryValidation>;
