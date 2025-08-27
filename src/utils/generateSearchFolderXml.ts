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
    "TemplateBuildingBlock": 2048,
    "BusinessProcessType": 4096,
    "VirtualFolder": 8192,
    "ProcessDefinition": 131074
  };

  const lockTypeMap: Record<string, number> = {
    "None": 0,
    "CheckedOut": 1,
    "Permanent": 2,
    "NewItem": 4,
    "InWorkflow": 8,
    "Reserved": 16
  };

  const publishStateMap: Record<string, number> = {
    "true": 1,
    "false": 0,
  };

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
    const recursive = searchQuery.SearchInSubtree ?? true;
    xml += `<SearchIn xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.SearchIn}" Recursive="${recursive}"/>`;
  }
  xml += `</GeneralParameters>`;

  // --- Advanced Parameters ---
  xml += `<AdvancedParameters>`;

  if (searchQuery.Title) { xml += `<Name caseSensitive="${!!searchQuery.IsTitleCaseSensitive}">${searchQuery.Title}</Name>`; }
  if (searchQuery.Description) { xml += `<Description caseSensitive="${!!searchQuery.IsDescriptionCaseSensitive}">${searchQuery.Description}</Description>`; }

  if (searchQuery.LastModifiedAfter || searchQuery.LastModifiedBefore) {
    const startDate = searchQuery.LastModifiedAfter || '0001-01-01T00:00:00';
    const endDate = searchQuery.LastModifiedBefore || '9999-12-31T23:59:59';
    xml += `<Modified><BetweenDates><StartDate>${startDate}</StartDate><EndDate>${endDate}</EndDate></BetweenDates></Modified>`;
  }
  if (searchQuery.ModifiedInLastDays) { xml += `<Modified><LastDays>${searchQuery.ModifiedInLastDays}</LastDays></Modified>`; }
  if (searchQuery.ModifiedInLastMonths) { xml += `<Modified><LastMonths>${searchQuery.ModifiedInLastMonths}</LastMonths></Modified>`; }

  if (searchQuery.ItemTypes && searchQuery.ItemTypes.length > 0) {
    xml += `<ItemTypes>`;
    searchQuery.ItemTypes.forEach(type => {
      xml += `<ItemType>${itemTypeMap[type]}</ItemType>`;
    });
    xml += `</ItemTypes>`;
  }

  if (searchQuery.BasedOnSchemas && searchQuery.BasedOnSchemas.length > 0) {
    xml += `<BasedOnSchema>`;
    searchQuery.BasedOnSchemas.forEach(filter => {
      xml += `<Schema xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${filter.schemaUri}">`;
      if (filter.fieldFilter) {
        xml += `<Element baseName="${filter.fieldFilter.name}">${filter.fieldFilter.value}</Element>`;
      }
      xml += `</Schema>`;
    });
    xml += `</BasedOnSchema>`;
  }

  if (searchQuery.UsedKeywords && searchQuery.UsedKeywords.length > 0) {
    const firstKeywordId = searchQuery.UsedKeywords[0];
    xml += toItemXlink(firstKeywordId, 'Keyword');
  }

  if (searchQuery.BlueprintStatus) {
    xml += `<BluePrinting StatusType="${searchQuery.BlueprintStatus}">`;
    if (searchQuery.FromRepository) {
      xml += `<Publication xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.FromRepository}"/>`;
    }
    xml += `</BluePrinting>`;
  }

  if (searchQuery.ProcessDefinition) {
    xml += `<WorkflowStatus>`;
    xml += `<Process xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.ProcessDefinition}">`;
    if (searchQuery.ActivityDefinition) {
      xml += `<Activity xlink:href="${searchQuery.ActivityDefinition}"></Activity>`;
    }
    xml += `</Process></WorkflowStatus>`;
  }

  if (searchQuery.Author) { xml += toItemXlink(searchQuery.Author, 'Author'); }

  if (searchQuery.LockType && searchQuery.LockType.length > 0) {
    const lockNum = searchQuery.LockType
      .map(type => lockTypeMap[type] ?? 0)
      .reduce((sum, val) => sum + val, 0);
      
    xml += `<LockStatus StatusType="${lockNum}">`;
    if (searchQuery.LockUser) {
      xml += `<User xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${searchQuery.LockUser}"></User>`;
    }
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