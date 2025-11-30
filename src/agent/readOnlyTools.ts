/**
 * This array lists all tool names that are considered "read-only".
 * The orchestrator uses this list to determine if a executed step was a write operation.
 * If a write operation occurs, it flags the UI to invalidate its cache for the
 * current context item.
 */
export const READ_ONLY_TOOLS = [
    'getCurrentTime',
    'requestNavigation',
    'requestOpenInEditor',
    'generateContentFromPrompt',
    'search',
    'getBatchOperationStatus',
    'getClassifiedItems',
    'getComponentTemplateLinks',
    'getDefaultModel',
    'getIsComponentTemplateRequired',
    'getItem',
    'bulkReadItems',
    'getItemHistory',
    'getItemsInContainer',
    'getLockedItems',
    'getMultimediaTypes',
    'getSchemaLinks',
    'getUsers',
    'getUserProfile',
    'getActivities',
    'getProcessDefinitions',
    'readTextFromWordMultimediaComponent',
    'readExcelFileFromMultimediaComponent',
    'readTextFromPowerPointMultimediaComponent',
    'readPdfFileFromMultimediaComponent',
    'readImageDetailsFromMultimediaComponent',
    'getBluePrintHierarchy',
    'getPublications',
    'getPublicationTypes',
    'getCategories',
    'getKeywordsForCategory',
    'getPublishTransactions',
    'getPublishInfo',
    'getTargetTypes',
    'getUsedByHistory',
    'getUsesForVersion',
    'getDependencyGraph',
    'mapItemIdToContextPublication'
];
