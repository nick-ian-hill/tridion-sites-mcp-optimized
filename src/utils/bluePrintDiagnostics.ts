import { AxiosInstance, isAxiosError } from "axios";
import { convertItemIdToContextPublication } from "./convertItemIdToContextPublication.js";

// Regex to identify potential TCM URIs in the input
const TCM_REGEX = /^(tcm:\d+-\d+(-\d+)?|ecl:[a-zA-Z0-9-]+)$/;

function extractIds(obj: any, ids: Set<string> = new Set()): Set<string> {
    if (!obj) return ids;
    if (typeof obj === 'string') {
        if (TCM_REGEX.test(obj)) ids.add(obj);
    } else if (Array.isArray(obj)) {
        obj.forEach(item => extractIds(item, ids));
    } else if (typeof obj === 'object') {
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) extractIds(obj[key], ids);
        }
    }
    return ids;
}

export async function diagnoseBluePrintError(
    error: any,
    args: any,
    contextId: string,
    axiosInstance: AxiosInstance
): Promise<void> {
    if (!isAxiosError(error)) return;

    const status = error.response?.status;
    if (!status) return;

    // =================================================================================
    // CHECK 1: SIBLING ISOLATION (Trigger on 404)
    // Referenced item exists elsewhere but not here.
    // =================================================================================
    if (status === 404 || status === 400) {
        const ids = extractIds(args);
        for (const originalId of ids) {
            const mappedId = convertItemIdToContextPublication(originalId, contextId);

            // Skip if no conversion occurred (already context ID)
            if (!mappedId || mappedId === originalId) continue;

            try {
                // 1. Verify it fails in the current context
                // Use GET with $select=Id to be lightweight but reliable
                try {
                    await axiosInstance.get(`/items/${mappedId.replace(':', '_')}?$select=Id`);
                    // If this succeeds, the item DOES exist here, so isolation isn't the issue.
                    continue; 
                } catch (localErr) {
                    // Expected: Item is missing in this context
                }

                // 2. CRITICAL CHECK: Does the ORIGINAL item exist?
                // We use GET here because HEAD is often unreliable for existence checks
                await axiosInstance.get(`/items/${originalId.replace(':', '_')}?$select=Id`);

                // SUCCESS: The original exists, but mapped does not.
                throw new Error(
                    `BluePrint Isolation Error: The item '${originalId}' exists but is NOT visible in the current publication ('${contextId}').\n` +
                    `This typically means '${originalId}' is located in a Sibling or Child Publication, not a Parent.\n` +
                    `Action: You cannot use this item directly. Promote it to a common Parent Publication, or use a different item.`
                );

            } catch (checkError: any) {
                // If we threw the Isolation Error above, strictly re-throw it.
                if (checkError.message?.includes("BluePrint Isolation Error")) {
                    throw checkError;
                }
                // Otherwise, the original item likely doesn't exist either. Ignore.
            }
        }
    }

    // =================================================================================
    // CHECK 2: INHERITANCE COLLISION (Trigger on 409 AND 400)
    // Trying to create an item that already exists from a parent.
    // =================================================================================
    if (status === 409 || status === 400) {
        const collisionCandidateName = args?.title || args?.name;
        const collisionCandidateId = args?.id;
        const parentFolderId = args?.folderId || args?.locationId;

        try {
            let existingItem: any = null;

            if (collisionCandidateId) {
                const checkResponse = await axiosInstance.get(`/items/${contextId}-${collisionCandidateId}`);
                existingItem = checkResponse.data;
            } else if (collisionCandidateName && parentFolderId) {
                const listResponse = await axiosInstance.get(`/items/${parentFolderId}/children`);
                const children = listResponse.data?.value || listResponse.data || [];
                existingItem = children.find((child: any) =>
                    child.Title === collisionCandidateName || child.Name === collisionCandidateName
                );
            }

            if (existingItem && existingItem.BluePrintInfo?.IsShared && error.response) {
                const bpInfo = existingItem.BluePrintInfo;
                const isPureInherited = !bpInfo.IsLocalized;
                const owningPub = bpInfo.OwningRepository?.Title || "Parent Publication";

                // MUTATE the error object for safe handling in orchestrator (Idempotency)
                if (isPureInherited) {
                    error.response.data = {
                        "BluePrint Efficiency Warning": `Item '${collisionCandidateName}' already exists via inheritance from '${owningPub}'.`,
                        "Instruction": "STOP: You do NOT need to create this item. It is already available.",
                        "ExistingItemID": existingItem.Id,
                        "Status": "409 Conflict (Inherited)"
                    };
                } else {
                    error.response.data = {
                        "Naming Collision": `Item '${collisionCandidateName}' already exists as a Localized copy from '${owningPub}'.`,
                        "Instruction": "Update the existing item or choose a new name.",
                        "Status": "409 Conflict (Localized)"
                    };
                }
            }
        } catch (checkError) {
            // Ignore lookup failures; preserve original error
        }
    }
}