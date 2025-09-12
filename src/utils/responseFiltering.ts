export interface FilterOptions {
    responseData: any;
    details?: "IdAndTitle" | "CoreDetails" | "AllDetails";
    includeProperties?: string[];
}

/**
 * Retrieves a nested property from an object using a dot-notation path.
 * @param obj The object to query.
 * @param path The dot-notation path to the property.
 * @returns The property value, or undefined if not found.
 */
const getNestedProperty = (obj: any, path: string): any => {
    if (obj === null || obj === undefined) {
        return undefined;
    }
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
};

/**
 * Sets a nested property on an object using a dot-notation path.
 * @param obj The object to modify.
 * @param path The dot-notation path for the property.
 * @param value The value to set.
 */
const setNestedProperty = (obj: any, path: string, value: any): void => {
    const keys = path.split('.');
    let current = obj;
    while (keys.length > 1) {
        const key = keys.shift()!;
        if (current[key] === undefined || typeof current[key] !== 'object' || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[keys[0]] = value;
};


/**
 * Applies a filtering function to an array of items.
 * @param items The array of items to filter.
 * @param filterFn The function to apply to each item.
 * @returns The new array with filtered items.
 */
const applyFilterToArray = (items: any[], filterFn: (item: any) => any): any[] => {
    if (!Array.isArray(items)) {
        return items;
    }
    return items.map(filterFn);
};

/**
 * Filters API response data based on the desired level of detail or a custom list of properties.
 * This utility handles responses that are a direct array of items, or objects containing an 'items' or 'Items' array.
 * @param options The filter options including the response data, details level, and custom properties.
 * @returns The filtered response data.
 */
export const filterResponseData = ({ responseData, details, includeProperties }: FilterOptions): any => {
    if (!responseData) {
        return responseData;
    }

    const hasCustomProperties = includeProperties && includeProperties.length > 0;
    let filterFn: ((item: any) => any) | null = null;

    // 1. Determine which filter function to use, if any.
    if (hasCustomProperties) {
        const baseProps = ['Id', 'Title', '$type'];
        filterFn = (item: any) => {
            const filteredItem: { [key: string]: any } = {};
            
            // Add base properties
            for (const key of baseProps) {
                if (key in item) {
                    filteredItem[key] = item[key];
                }
            }

            // Add requested nested/toplevel properties
            for (const path of includeProperties!) {
                const value = getNestedProperty(item, path);
                if (value !== undefined) {
                    setNestedProperty(filteredItem, path, value);
                }
            }
            return filteredItem;
        };
    } else if (details === 'IdAndTitle') {
        const propsToInclude = new Set(['Id', 'Title', '$type']);
        filterFn = (item: any) => {
            const filteredItem: { [key: string]: any } = {};
            for (const key of propsToInclude) {
                if (key in item) {
                    filteredItem[key] = item[key];
                }
            }
            return filteredItem;
        };
    } else if (details === 'CoreDetails') {
        const propertiesToExclude = new Set([
            'AccessControlList', 'ApplicableActions', 'ApprovalStatus', 'ContentSecurityDescriptor',
            'ExtensionProperties', 'ListLinks', 'SecurityDescriptor', 'LoadInfo'
        ]);
        filterFn = (item: any) => Object.fromEntries(
            Object.entries(item).filter(([key]) => !propertiesToExclude.has(key))
        );
    }

    // 2. If a filter function was selected, apply it to the appropriate data shape.
    if (filterFn) {
        if (Array.isArray(responseData)) {
            return applyFilterToArray(responseData, filterFn);
        }
        if (responseData.items && Array.isArray(responseData.items)) {
            return { ...responseData, items: applyFilterToArray(responseData.items, filterFn) };
        }
        if (responseData.Items && Array.isArray(responseData.Items)) {
            return { ...responseData, Items: applyFilterToArray(responseData.Items, filterFn) };
        }
    }

    // 3. If no filtering was needed, return the original data.
    return responseData;
};