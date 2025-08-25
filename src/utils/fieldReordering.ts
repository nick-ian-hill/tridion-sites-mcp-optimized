import { authenticatedAxios } from "../lib/axios.js";

// A cache to store schema field orders to reduce redundant API calls.
const schemaCache = new Map<string, string[]>();

/**
 * Fetches the ordered list of field names from a Schema definition.
 * Caches the result to avoid repeated lookups for the same schema.
 * @param schemaId The TCM URI of the Schema.
 * @param fieldType 'content' or 'metadata'.
 * @returns An array of field names in their correct order.
 */
async function getOrderedFieldNames(schemaId: string, fieldType: 'content' | 'metadata'): Promise<string[]> {
    const cacheKey = `${schemaId}-${fieldType}`;
    if (schemaCache.has(cacheKey)) {
        return schemaCache.get(cacheKey)!;
    }

    const restSchemaId = schemaId.replace(':', '_');
    const response = await authenticatedAxios.get(`/items/${restSchemaId}`);
    if (response.status !== 200 || response.data?.$type !== 'Schema') {
        throw new Error(`Failed to fetch or validate Schema with ID ${schemaId}.`);
    }

    const schema = response.data;
    const fieldDefinitions = fieldType === 'content' ? schema.Fields : schema.MetadataFields;

    if (!fieldDefinitions) {
        return [];
    }

    // The API returns the dictionary keys in the correct definition order.
    const orderedNames = Object.keys(fieldDefinitions);
    schemaCache.set(cacheKey, orderedNames);
    return orderedNames;
}

/**
 * Recursively reorders the properties of a data object to match the field order defined in a Schema.
 * @param data The data object (e.g., content or metadata) to reorder.
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
            
            // Check if this field is an embedded schema field that needs recursive reordering
            const restSchemaId = schemaId.replace(':', '_');
            const schemaResponse = await authenticatedAxios.get(`/items/${restSchemaId}`);
            const fieldDefinition = (fieldType === 'content' ? schemaResponse.data.Fields : schemaResponse.data.MetadataFields)?.[fieldName];

            if (fieldDefinition?.$type === 'EmbeddedSchemaFieldDefinition' && fieldDefinition.EmbeddedSchema?.IdRef) {
                const embeddedSchemaId = fieldDefinition.EmbeddedSchema.IdRef;
                if (Array.isArray(fieldValue)) {
                    // Reorder each object in a multi-value embedded field
                    reorderedData[fieldName] = await Promise.all(
                        fieldValue.map(item => reorderFieldsBySchema(item, embeddedSchemaId, 'content'))
                    );
                } else if (typeof fieldValue === 'object' && fieldValue !== null) {
                    // Reorder a single embedded field object
                    reorderedData[fieldName] = await reorderFieldsBySchema(fieldValue, embeddedSchemaId, 'content');
                } else {
                    reorderedData[fieldName] = fieldValue;
                }
            } else {
                reorderedData[fieldName] = fieldValue;
            }
        }
    }

    // Append any fields present in the data but not in the schema (graceful handling)
    for (const key in data) {
        if (!reorderedData.hasOwnProperty(key)) {
            reorderedData[key] = data[key];
        }
    }

    return reorderedData;
}