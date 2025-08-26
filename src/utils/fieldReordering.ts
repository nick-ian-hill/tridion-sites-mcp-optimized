import { authenticatedAxios } from "../lib/axios.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

// Cache for storing ordered field names from schemas to reorder data.
const schemaFieldOrderCache = new Map<string, string[]>();
// Cache for storing full schema definitions to avoid refetching when processing definitions.
const schemaDefinitionCache = new Map<string, any>();

/**
 * Fetches the ordered list of field names from a Schema definition for data objects.
 * Caches the result to avoid repeated lookups for the same schema.
 * @param schemaId The TCM URI of the Schema.
 * @param fieldType 'content' or 'metadata'.
 * @returns An array of field names in their correct order.
 */
async function getOrderedFieldNames(schemaId: string, fieldType: 'content' | 'metadata'): Promise<string[]> {
    const cacheKey = `${schemaId}-${fieldType}`;
    if (schemaFieldOrderCache.has(cacheKey)) {
        return schemaFieldOrderCache.get(cacheKey)!;
    }

    const restSchemaId = schemaId.replace(':', '_');
    const response = await authenticatedAxios.get(`/items/${restSchemaId}`);
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
 * @param data The data object to reorder.
 * @param schemaId The TCM URI of the Schema defining the order.
 * @param fieldType Specifies whether to use 'content' or 'metadata' fields from the schema.
 * @returns A new object with properties sorted according to the Schema definition.
 */
export async function reorderFieldsBySchema(data: Record<string, any>, schemaId: string, fieldType: 'content' | 'metadata'): Promise<Record<string, any>> {
    const orderedFieldNames = await getOrderedFieldNames(schemaId, fieldType);
    const reorderedData: Record<string, any> = {};

    for (const fieldName of orderedFieldNames) {
        if (data.hasOwnProperty(fieldName)) {
            const fieldValue = data[fieldName];
            
            const schemaDefinition = schemaDefinitionCache.get(schemaId) || (await authenticatedAxios.get(`/items/${schemaId.replace(':', '_')}`)).data;
            const fieldDefinition = (fieldType === 'content' ? schemaDefinition.Fields : schemaDefinition.MetadataFields)?.[fieldName];

            if (fieldDefinition?.$type === 'EmbeddedSchemaFieldDefinition' && fieldDefinition.EmbeddedSchema?.IdRef) {
                const embeddedSchemaId = fieldDefinition.EmbeddedSchema.IdRef;
                if (Array.isArray(fieldValue)) {
                    reorderedData[fieldName] = await Promise.all(
                        fieldValue.map(item => reorderFieldsBySchema(item, embeddedSchemaId, 'content'))
                    );
                } else if (typeof fieldValue === 'object' && fieldValue !== null) {
                    reorderedData[fieldName] = await reorderFieldsBySchema(fieldValue, embeddedSchemaId, 'content');
                } else {
                    reorderedData[fieldName] = fieldValue;
                }
            } else {
                reorderedData[fieldName] = fieldValue;
            }
        }
    }

    for (const key in data) {
        if (!reorderedData.hasOwnProperty(key)) {
            reorderedData[key] = data[key];
        }
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
        if (currentObject.$type === "Link" && typeof currentObject.IdRef === 'string') {
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
 * context and automatically populates the 'EmbeddedFields' property for any EmbeddedSchemaFieldDefinition
 * by fetching the definition from the linked Schema, using a cache to avoid redundant fetches.
 * @param fieldDefinitions A dictionary of field definitions.
 * @param contextId The TCM URI of the context item (e.g., the Schema's parent Folder).
 * @returns A promise that resolves to the processed dictionary of field definitions.
 */
export async function processSchemaFieldDefinitions(fieldDefinitions: Record<string, any>, contextId: string): Promise<Record<string, any>> {
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
                    const response = await authenticatedAxios.get(`/items/${restSchemaId}`);
                    if (response.status === 200 && response.data?.$type === 'Schema') {
                        embeddedSchemaDef = response.data;
                        schemaDefinitionCache.set(embeddedSchemaId, embeddedSchemaDef); // Cache the fetched definition
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
