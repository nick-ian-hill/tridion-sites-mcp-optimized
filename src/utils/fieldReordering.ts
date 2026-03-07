import { SimpleLRUCache } from "./lruCache.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";
import { AxiosInstance } from "axios";

// Cache for storing ordered field names from schemas to reorder data.
const schemaFieldOrderCache = new SimpleLRUCache<string[]>();
// Cache for storing full schema definitions to avoid refetching when processing definitions.
const schemaDefinitionCache = new SimpleLRUCache<any>();

/**
 * Explicitly invalidates a Schema from the cache.
 * Must be called by tools that modify Schema definitions.
 * @param schemaId The TCM URI of the Schema to invalidate.
 */
export function invalidateSchemaCache(schemaId: string) {
    schemaDefinitionCache.delete(schemaId);
    // schemaFieldOrderCache uses keys formatted as `${schemaId}-${fieldType}`
    schemaFieldOrderCache.deleteByPrefix(`${schemaId}-`);
}

/**
 * Fetches the ordered list of field names from a Schema definition for data objects.
 * Caches the result to avoid repeated lookups for the same schema.
 * @param schemaId The TCM URI of the Schema.
 * @param fieldType 'content' or 'metadata'.
 * @param axiosInstance An authenticated Axios instance.
 * @returns An array of field names in their correct order.
 */
async function getOrderedFieldNames(schemaId: string, fieldType: 'content' | 'metadata', axiosInstance: AxiosInstance): Promise<string[]> {
    const cacheKey = `${schemaId}-${fieldType}`;
    const cachedOrder = schemaFieldOrderCache.get(cacheKey);

    if (cachedOrder) {
        return cachedOrder;
    }

    const restSchemaId = schemaId.replace(':', '_');
    const response = await axiosInstance.get(`/items/${restSchemaId}`);
    if (response.status !== 200 || response.data?.$type !== 'Schema') {
        throw new Error(`Failed to fetch or validate Schema with ID ${schemaId}.`);
    }

    const schema = response.data;
    schemaDefinitionCache.set(schemaId, schema); // Also cache the full definition.

    const fieldDefinitions = fieldType === 'content' ? schema.Fields : schema.MetadataFields;
    if (!fieldDefinitions) {
        return [];
    }

    const orderedNames = Object.keys(fieldDefinitions);
    schemaFieldOrderCache.set(cacheKey, orderedNames);
    return orderedNames;
}

/**
 * Recursively reorders the properties of a data object (content/metadata) to match the field order defined in a Schema.
 * Validates that all provided fields actually exist in the Schema.
 * @param data The data object to reorder.
 * @param schemaId The TCM URI of the Schema defining the order.
 * @param fieldType Specifies whether to use 'content' or 'metadata' fields from the schema.
 * @param axiosInstance An authenticated Axios instance.
 * @returns A new object with properties sorted according to the Schema definition.
 * @throws Error if the data contains fields not present in the Schema.
 */
export async function reorderFieldsBySchema(data: Record<string, any>, schemaId: string, fieldType: 'content' | 'metadata', axiosInstance: AxiosInstance): Promise<Record<string, any>> {
    const orderedFieldNames = await getOrderedFieldNames(schemaId, fieldType, axiosInstance);

    // Validate that all fields in 'data' exist in the schema (ignoring system properties)
    const inputKeys = Object.keys(data).filter(key =>
        key !== '$type' &&
        key !== '@id'
    );
    const unknownKeys = inputKeys.filter(key => !orderedFieldNames.includes(key));

    if (unknownKeys.length > 0) {
        throw new Error(
            `Validation Error: The following fields provided in the input are not defined in the ${fieldType} schema (${schemaId}): [${unknownKeys.join(', ')}]. ` +
            `Available fields are: [${orderedFieldNames.join(', ')}].`
        );
    }

    const reorderedData: Record<string, any> = {};

    for (const fieldName of orderedFieldNames) {
        if (data.hasOwnProperty(fieldName)) {
            const fieldValue = data[fieldName];

            // Try to get from cache first, otherwise fetch
            let schemaDefinition = schemaDefinitionCache.get(schemaId);
            if (!schemaDefinition) {
                schemaDefinition = (await axiosInstance.get(`/items/${schemaId.replace(':', '_')}`)).data;
                schemaDefinitionCache.set(schemaId, schemaDefinition);
            }

            const fieldDefinition = (fieldType === 'content' ? schemaDefinition.Fields : schemaDefinition.MetadataFields)?.[fieldName];

            if (fieldDefinition?.$type === 'EmbeddedSchemaFieldDefinition' && fieldDefinition.EmbeddedSchema?.IdRef) {
                const embeddedSchemaId = fieldDefinition.EmbeddedSchema.IdRef;

                if (Array.isArray(fieldValue)) {
                    reorderedData[fieldName] = await Promise.all(
                        fieldValue.map(item => reorderFieldsBySchema(item, embeddedSchemaId, 'content', axiosInstance))
                    );
                } else if (typeof fieldValue === 'object' && fieldValue !== null) {
                    reorderedData[fieldName] = await reorderFieldsBySchema(fieldValue, embeddedSchemaId, 'content', axiosInstance);
                } else {
                    reorderedData[fieldName] = fieldValue;
                }
            } else {
                reorderedData[fieldName] = fieldValue;
            }
        }
    }

    // --- PRESERVE SYSTEM PROPERTIES ---
    if (data['$type']) {
        reorderedData['$type'] = data['$type'];
    }

    if (data['@id']) {
        reorderedData['@id'] = data['@id'];
    }

    return reorderedData;
}

/**
 * Helper function to recursively find and convert all Link IdRefs within any object or array.
 * @param currentObject The object or array to traverse.
 * @param contextId The TCM URI of the context item used to resolve publication IDs.
 */
export const convertLinksRecursively = (currentObject: any, contextId: string) => {
    if (!currentObject || typeof currentObject !== 'object') return;

    if (Array.isArray(currentObject)) {
        currentObject.forEach(item => convertLinksRecursively(item, contextId));
    } else {
        if ((currentObject.$type === "Link" || currentObject.$type === "ExpandableLink") &&
            typeof currentObject.IdRef === 'string') {
            currentObject.IdRef = convertItemIdToContextPublication(currentObject.IdRef, contextId);
        }
        for (const key in currentObject) {
            if (Object.prototype.hasOwnProperty.call(currentObject, key)) {
                convertLinksRecursively(currentObject[key], contextId);
            }
        }
    }
};

/**
 * Processes a dictionary of Schema field definitions. It converts all Link IdRefs to the correct
 * context and automatically populates the 'EmbeddedFields' property for any EmbeddedSchemaFieldDefinition.
 * @param fieldDefinitions A dictionary of field definitions.
 * @param contextId The TCM URI of the context item (e.g., the Schema's parent Folder).
 * @param axiosInstance An authenticated Axios instance.
 * @returns A promise that resolves to the processed dictionary of field definitions.
 */
export async function processSchemaFieldDefinitions(fieldDefinitions: Record<string, any>, contextId: string, axiosInstance: AxiosInstance): Promise<Record<string, any>> {
    if (!fieldDefinitions) return {};

    const processedFields = JSON.parse(JSON.stringify(fieldDefinitions));

    for (const fieldName in processedFields) {
        const fieldDef = processedFields[fieldName];
        convertLinksRecursively(fieldDef, contextId);

        if (fieldDef.$type === "EmbeddedSchemaFieldDefinition" && fieldDef.EmbeddedSchema?.IdRef) {
            const embeddedSchemaId = fieldDef.EmbeddedSchema.IdRef;
            let embeddedSchemaDef = schemaDefinitionCache.get(embeddedSchemaId);

            if (!embeddedSchemaDef) {
                try {
                    const restSchemaId = embeddedSchemaId.replace(':', '_');
                    const response = await axiosInstance.get(`/items/${restSchemaId}`);
                    if (response.status === 200 && response.data?.$type === 'Schema') {
                        embeddedSchemaDef = response.data;
                        schemaDefinitionCache.set(embeddedSchemaId, embeddedSchemaDef);
                    }
                } catch (error) {
                    console.error(`Error fetching embedded schema ${embeddedSchemaId}: ${String(error)}.`);
                }
            }

            if (embeddedSchemaDef) {
                fieldDef.EmbeddedFields = embeddedSchemaDef.Fields || { "$type": "FieldsDefinitionDictionary" };
            } else {
                console.warn(`Could not fetch or validate embedded schema ${embeddedSchemaId}. Defaulting to empty EmbeddedFields.`);
                fieldDef.EmbeddedFields = { "$type": "FieldsDefinitionDictionary" };
            }
        }
    }
    return processedFields;
}

/**
 * Processes an array of field definitions, maps external links, and strictly 
 * converts them into a FieldsDefinitionDictionary preserving the exact array sequence.
 * @param fieldArray An array of field definitions.
 * @param contextId The TCM URI of the context item.
 * @param axiosInstance An authenticated Axios instance.
 * @returns A promise that resolves to the ordered FieldsDefinitionDictionary.
 */
export async function processAndOrderFieldDefinitions(fieldArray: any[], contextId: string, axiosInstance: AxiosInstance): Promise<Record<string, any>> {
    if (!fieldArray || fieldArray.length === 0) {
        return { "$type": "FieldsDefinitionDictionary" };
    }

    // Convert array to a temporary dictionary for processing
    const tempRecord: Record<string, any> = {};
    fieldArray.forEach((field: any) => {
        if (field.Name) tempRecord[field.Name] = field;
    });

    // Process links and embedded fields using the existing dictionary logic
    const processedFields = await processSchemaFieldDefinitions(tempRecord, contextId, axiosInstance);

    // Rebuild the final dictionary strictly using the order of the original array
    const orderedFields: Record<string, any> = { "$type": "FieldsDefinitionDictionary" };
    fieldArray.forEach((field: any) => {
        if (field.Name && processedFields[field.Name]) {
            orderedFields[field.Name] = processedFields[field.Name];
        }
    });

    return orderedFields;
}

/**
 * Recursively formats an object from the Agent (using 'type') to be API-compatible (using '$type').
 * 1. Renames 'type' to '$type'.
 * 2. Ensures '$type' is the first key in any object.
 * This function mutates the object in place.
 *
 * @param obj The object or array to format.
 */
export function formatForApi(obj: any): any {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        obj.forEach(formatForApi);
        return obj;
    }

    let typeValue: any = undefined;

    if (obj.hasOwnProperty('type')) {
        typeValue = obj['type'];
        delete obj['type'];
    } else if (obj.hasOwnProperty('$type')) {
        typeValue = obj['$type'];
        delete obj['$type'];
    }

    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            formatForApi(obj[key]);
        }
    }

    if (typeValue !== undefined) {
        const rest = { ...obj }; // Get all other formatted child properties

        // Clear all keys from the original object
        Object.keys(obj).forEach(key => delete obj[key]);

        // Re-assign them with '$type' first
        Object.assign(obj, { '$type': typeValue, ...rest });
    }

    return obj;
}

/**
 * Recursively formats a raw API response (using '$type') to be Agent-friendly (using 'type').
 * 1. Renames '$type' to 'type'.
 * 2. Ensures 'type' is the first key in any object.
 * 3. Strips '-v0' suffix from TCM URIs (unchecked-in new items) to ensure validation compatibility.
 * 4. Removes 'ExtensionXml' to reduce cognitive load and prevent round-trip errors.
 * This function returns a new object and does not mutate the original.
 *
 * @param obj The raw API object or array to format.
 */
export function formatForAgent(obj: any): any {
    if (!obj || typeof obj !== 'object') {
        // Sanitize TCM URIs ending in -v0 (e.g., tcm:5-123-v0 -> tcm:5-123)
        // This prevents Zod validation errors in subsequent tool calls, as -v0 implies a 
        // new item that hasn't been checked in yet, but the base ID is sufficient for interactions.
        if (typeof obj === 'string' && obj.startsWith('tcm:') && obj.endsWith('-v0')) {
            return obj.slice(0, -3);
        }
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(formatForAgent); // Recurse into arrays, returning a new array
    }

    // Intercept FieldsDefinitionDictionary and convert it to an array for the agent
    if (obj['$type'] === 'FieldsDefinitionDictionary') {
        const fieldArray: any[] = [];
        for (const key in obj) {
            if (key !== '$type' && key !== 'ExtensionXml') {
                fieldArray.push(formatForAgent(obj[key]));
            }
        }
        return fieldArray;
    }

    const newObj: { [key: string]: any } = {};
    let typeValue: any = undefined;

    // 1. Recurse into all properties
    for (const key in obj) {
        // FILTER: Skip ExtensionXml to avoid exposing it to the agent
        if (key === 'ExtensionXml') continue;

        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const formattedValue = formatForAgent(obj[key]);
            if (key === '$type') {
                typeValue = formattedValue;
            } else {
                newObj[key] = formattedValue;
            }
        }
    }

    // 2. Add the 'type' property at the beginning
    if (typeValue !== undefined) {
        const { ...rest } = newObj;
        return { 'type': typeValue, ...rest };
    }

    return newObj; // Return the new object
}

/**
 * Performs a "Smart Merge" of source into target.
 * - Objects are merged recursively (properties in target but not in source are preserved).
 * - Arrays are merged by index (target items at indices beyond source length are preserved).
 * - Explicit 'null' in source array PRESERVES the target item at that index.
 */
export function deepMerge(target: any, source: any): any {
    // 1. Handle Primitives and non-mergeable types (including null acting as value)
    if (typeof source !== 'object' || source === null) {
        return source;
    }

    // 2. Handle Arrays (Smart Merge by Index)
    if (Array.isArray(source)) {
        if (!Array.isArray(target)) {
            // Target isn't an array, so we overwrite with source
            return source;
        }

        const maxLength = Math.max(target.length, source.length);
        const result = [];

        for (let i = 0; i < maxLength; i++) {
            if (i < source.length && i < target.length) {
                // Both exist.
                // SPECIAL CHECK: If source[i] is NULL, we interpret this as "SKIP/PRESERVE".
                if (source[i] === null) {
                    result.push(target[i]);
                } else {
                    // Otherwise, recursively merge
                    result.push(deepMerge(target[i], source[i]));
                }
            } else if (i < source.length) {
                // Only in source (newly added item)
                result.push(source[i]);
            } else {
                // Only in target (preserved existing item)
                result.push(target[i]);
            }
        }
        return result;
    }

    // 3. Handle Objects (Recursive Merge)
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        // If target is not an object (or is null/array), we cannot merge properties. Overwrite.
        return source;
    }

    const output = { ...target };
    Object.keys(source).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            if (key in target) {
                output[key] = deepMerge(target[key], source[key]);
            } else {
                output[key] = source[key];
            }
        }
    });
    return output;
}