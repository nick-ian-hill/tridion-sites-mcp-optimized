export interface FilterOptions {
    responseData: any;
    details?: "IdAndTitle" | "CoreDetails" | "AllDetails";
    includeProperties?: string[];
}

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
        const propsToInclude = new Set([...baseProps, ...includeProperties]);
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