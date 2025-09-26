export interface FilterOptions {
    responseData: any;
    details?: "IdAndTitle" | "CoreDetails" | "AllDetails";
    includeProperties?: string[];
}

/**
 * Defines the shape of a recursive dependency graph node.
 */
interface DependencyGraphNode {
    Item?: any;
    Dependencies?: DependencyGraphNode[];
    [key: string]: any; // Allows for other properties like $type, HasMore, etc.
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
 * Recursively applies a filter function to a DependencyGraphNode and its children.
 * @param node The DependencyGraphNode to filter.
 * @param filterFn The function to apply to the Item property of each node.
 * @returns The new, filtered DependencyGraphNode.
 */
const filterDependencyGraphNode = (node: DependencyGraphNode, filterFn: (item: any) => any): DependencyGraphNode => {
    if (!node || typeof node !== 'object') return node;

    const filteredNode: DependencyGraphNode = { ...node };

    if (node.Item) {
        filteredNode.Item = filterFn(node.Item);
    }

    // With the interface, TypeScript now knows 'dep' is a DependencyGraphNode, fixing the error.
    if (node.Dependencies && Array.isArray(node.Dependencies)) {
        filteredNode.Dependencies = node.Dependencies.map(dep => filterDependencyGraphNode(dep, filterFn));
    }

    return filteredNode;
};

export const filterResponseData = ({ responseData, details, includeProperties }: FilterOptions): any => {
    if (!responseData) {
        return responseData;
    }

    const hasCustomProperties = includeProperties && includeProperties.length > 0;
    let filterFn: ((item: any) => any) | null = null;

    if (hasCustomProperties) {
        const baseProps = ['Id', 'Title', '$type'];
        filterFn = (item: any) => {
            if (typeof item !== 'object' || item === null) return item;
            const filteredItem: { [key: string]: any } = {};
            for (const key of baseProps) {
                if (key in item) {
                    filteredItem[key] = item[key];
                }
            }
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
            if (typeof item !== 'object' || item === null) return item;
            const filteredItem: { [key: string]: any } = {};
            for (const key of propsToInclude) {
                if (key in item) filteredItem[key] = item[key];
            }
            return filteredItem;
        };
    } else if (details === 'CoreDetails') {
        const propertiesToExclude = new Set([
            'AccessControlList', 'ApplicableActions', 'ApprovalStatus', 'ContentSecurityDescriptor',
            'ExtensionProperties', 'ListLinks', 'SecurityDescriptor', 'LoadInfo'
        ]);
        filterFn = (item: any) => {
            if (typeof item !== 'object' || item === null) return item;
            return Object.fromEntries(
                Object.entries(item).filter(([key]) => !propertiesToExclude.has(key))
            );
        };
    }

    if (!filterFn) return responseData;
    
    // Handle recursive DependencyGraphNode structure (from some dependencyGraph calls)
    if (responseData.$type === 'DependencyGraphNode' && responseData.Item && responseData.Dependencies) {
        return filterDependencyGraphNode(responseData, filterFn);
    }

    if (Array.isArray(responseData)) {
        return applyFilterToArray(responseData, filterFn);
    }
    if (responseData.items && Array.isArray(responseData.items)) {
        return { ...responseData, items: applyFilterToArray(responseData.items, filterFn) };
    }
    if (responseData.Items && Array.isArray(responseData.Items)) {
        return { ...responseData, Items: applyFilterToArray(responseData.Items, filterFn) };
    }
    
    if (typeof responseData === 'object' && responseData !== null) {
        const filteredDictionary: { [key: string]: any } = {};
        for (const key in responseData) {
            if (Object.prototype.hasOwnProperty.call(responseData, key)) {
                filteredDictionary[key] = filterFn(responseData[key]);
            }
        }
        return filteredDictionary;
    }

    return responseData;
};