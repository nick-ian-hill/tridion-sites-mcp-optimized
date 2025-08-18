import { SearchQuery } from "../schemas/searchSchema.js";

/**
 * Generates the XML configuration string for a SearchFolder based on the provided SearchQuery.
 * @param searchQuery The search query object.
 * @param resultLimit The maximum number of results.
 * @returns A string containing the XML configuration.
 */
export const generateSearchFolderXmlConfiguration = (
  searchQuery: SearchQuery,
  resultLimit: number = 100,
): string => {
  const itemTypeMap: Record<string, number> = {
    "Folder": 2,
    "StructureGroup": 4,
    "Schema": 8,
    "Component": 16,
    "ComponentTemplate": 32,
    "Page": 64,
    "PageTemplate": 128,
    "TargetGroup": 256,
    "Category": 512,
    "Keyword": 1024,
    "TemplateBuildingBlock": 2042,
    "BusinessProcessType": 4096,
    "VirtualFolder": 8192,
    "ProcessDefinition": 131074
  };

  const lockTypeMap: Record<string, number> = {
    "None": 0,
    "CheckedOut": 1,
    "Permanent": 2,
    "InWorkflow": 3,
  };

  const publishStateMap: Record<string, number> = {
    "true": 1,
    "false": 0,
  };

  // Helper function for creating a Link element string for a single item.
  const toItemXlink = (id?: string, name: string = ""): string => {
    if (!id) return '';
    return `<${name} xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${id}"/>`;
  };

  let xml = `<SearchFolder xmlns="http://www.tridion.com/ContentManager/5.1/SearchFolder">`;

  // --- General Parameters ---
  xml += `<GeneralParameters>`;
  if (searchQuery.FullTextQuery) {
    xml += `<SearchQuery>${searchQuery.FullTextQuery}</SearchQuery>`;
  } else {
    xml += `<SearchQuery/>`;
  }
  if (searchQuery.SearchIn) {
    xml += `<SearchIn xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.SearchIn}" Recursive="${searchQuery.SearchInSubtree || true}"/>`;
  }
  xml += `</GeneralParameters>`;

  // --- Advanced Parameters ---
  xml += `<AdvancedParameters>`;

  if (searchQuery.Title) { xml += `<Title>${searchQuery.Title}</Title>`; }
  if (searchQuery.Description) { xml += `<Description>${searchQuery.Description}</Description>`; }
  if (searchQuery.LastModifiedAfter) { xml += `<ModifiedAfter>${searchQuery.LastModifiedAfter}</ModifiedAfter>`; }
  if (searchQuery.LastModifiedBefore) { xml += `<ModifiedBefore>${searchQuery.LastModifiedBefore}</ModifiedBefore>`; }
  if (searchQuery.ModifiedInLastDays) { xml += `<ModifiedInLastDays>${searchQuery.ModifiedInLastDays}</ModifiedInLastDays>`; }
  if (searchQuery.ModifiedInLastMonths) { xml += `<ModifiedInLastMonths>${searchQuery.ModifiedInLastMonths}</ModifiedInLastMonths>`; }
  if (searchQuery.IsTitleCaseSensitive) { xml += `<IsTitleCaseSensitive>${searchQuery.IsTitleCaseSensitive}</IsTitleCaseSensitive>`; }
  if (searchQuery.IsDescriptionCaseSensitive) { xml += `<IsDescriptionCaseSensitive>${searchQuery.IsDescriptionCaseSensitive}</IsDescriptionCaseSensitive>`; }

  // --- Arrays and specific item types ---
  if (searchQuery.ItemTypes && searchQuery.ItemTypes.length > 0) {
    xml += `<ItemTypes>`;
    searchQuery.ItemTypes.forEach(type => {
      xml += `<ItemType>${itemTypeMap[type]}</ItemType>`;
    });
    xml += `</ItemTypes>`;
  }

  if (searchQuery.BasedOnSchemas && searchQuery.BasedOnSchemas.length > 0) {
    xml += `<BasedOnSchema>`;
    searchQuery.BasedOnSchemas.forEach(id => {
      xml += toItemXlink(id, 'Schema');
    });
    xml += `</BasedOnSchema>`;
  }

  if (searchQuery.UsedKeywords && searchQuery.UsedKeywords.length > 0) {
    xml += `<Keyword>`;
    searchQuery.UsedKeywords.forEach(id => {
      xml += toItemXlink(id, 'Keyword');
    });
    xml += `</Keyword>`;
  }

  // --- Blueprinting ---
  if (searchQuery.BlueprintStatus) {
    xml += `<BluePrinting`;
    if (searchQuery.BlueprintStatus) { xml += ` StatusType="${searchQuery.BlueprintStatus}"`; }
    if (searchQuery.FromRepository) { xml += `/><Publication xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.FromRepository}" />`; }
    xml += ` />`;
  }

  // --- Workflow ---
  if (searchQuery.ActivityDefinition || searchQuery.ProcessDefinition) {
    xml += `<WorkflowStatus>`;
    if (searchQuery.ActivityDefinition) { xml += toItemXlink(searchQuery.ActivityDefinition, 'ActivityDefinition'); }
    if (searchQuery.ProcessDefinition) { xml += toItemXlink(searchQuery.ProcessDefinition, 'ProcessDefinition'); }
    xml += `</WorkflowStatus>`;
  }

  // --- Link-based properties ---
  if (searchQuery.Author) { xml += toItemXlink(searchQuery.Author, 'Author'); }
  if (searchQuery.LockUser) { xml += toItemXlink(searchQuery.LockUser, 'LockUser'); }

  // --- Enum/Boolean properties ---
    if (searchQuery.LockType && searchQuery.LockType.length > 0) {
    xml += `<LockStatus>`;
    searchQuery.LockType.forEach(type => {
      xml += `<LockType>${lockTypeMap[type]}</LockType>`;
    });
    xml += `</LockStatus>`;
  }

  if (searchQuery.IsPublished !== undefined) {
    xml += `<PublishState>${publishStateMap[String(searchQuery.IsPublished)]}</PublishState>`;
  }
  if (resultLimit) { xml += `<NumberOfItems>${resultLimit}</NumberOfItems>`; }
  xml += `</AdvancedParameters>`;
  xml += `</SearchFolder>`;

  return xml;
};