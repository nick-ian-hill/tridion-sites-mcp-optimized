/**
 * A utility function to convert a TCM or ECL item ID to match the publication ID
 * of a context item. This is useful for ensuring links and references
 * point to the correct publication in a multi-publication environment.
 *
 * The function will not modify 'tcm:0-pubId-1' IDs.
 *
 * @param {string} itemId The item ID to be converted.
 * @param {string} contextItemId The item ID containing the target publication.
 * @returns {string} The converted item ID, or the original ID if no conversion was possible.
 */
export const convertItemIdToContextPublication = (itemId: string, contextItemId: string): string => {
    if (itemId === 'tcm:0-0-0') {
        return itemId;
    }
    // A single regex to match and capture the prefix, publication ID, and rest of the ID for both TCM and ECL.
    // Group 1: The prefix ('tcm' or 'ecl')
    // Group 2: The publication ID (a number)
    // Group 3: The rest of the ID
    const uriRegex = /^(tcm|ecl):(\d+)-(.+)$/;

    // A specific regex for the TCM Publication URI format.
    const tcmPublicationRegex = /^tcm:0-(\d+)-1$/;

    // Determine the type of the context item and extract the publication ID.
    let contextPublicationId: string | null = null;

    const contextPublicationMatch = contextItemId.match(tcmPublicationRegex);
    if (contextPublicationMatch) {
        // If it's a publication URI, the ID is the captured group.
        contextPublicationId = contextPublicationMatch[1];
    } else {
        // Otherwise, use the general URI regex.
        const contextMatch = contextItemId.match(uriRegex);
        if (contextMatch) {
            contextPublicationId = contextMatch[2];
        } else {
            console.warn(`Context ID '${contextItemId}' is not a valid TCM or ECL ID. Returning original item ID.`);
            return itemId;
        }
    }

    // Determine the type of the item to be converted and apply the new publication ID.
    const itemPublicationMatch = itemId.match(tcmPublicationRegex);
    if (itemPublicationMatch) {
        // If the item to be converted is a TCM publication URI, return it unchanged.
        return itemId;
    }

    const itemMatch = itemId.match(uriRegex);
    if (itemMatch) {
        const itemPrefix = itemMatch[1];
        const itemContentId = itemMatch[3];
        // The item to be converted should maintain its original prefix (tcm or ecl).
        return `${itemPrefix}:${contextPublicationId}-${itemContentId}`;
    } else {
        // If the item to be converted does not match the URI format, return it unchanged.
        return itemId;
    }
}