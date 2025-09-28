import { AxiosInstance } from "axios";
import { handleUnexpectedResponse } from "./errorUtils.js";

/**
 * A standard response structure for versioning operations.
 */
export interface VersioningResult {
    /** The item data, potentially updated after a checkout operation. */
    item: any;
    /** A boolean flag indicating if the checkout was performed by this operation. */
    wasCheckedOutByTool: boolean;
    /** An optional error message if the operation could not be completed (e.g., locked by another user). */
    error?: string;
}

/**
 * Handles the check-out process for a versioned item.
 * It checks if the item is already checked out, and if so, by whom.
 * If it's not checked out, it performs a check-out.
 * @param itemId The TCM URI of the item.
 * @param item The initial item data object.
 * @param axiosInstance An authenticated Axios instance.
 * @returns A promise that resolves to a VersioningResult object.
 */
export async function handleCheckout(itemId: string, item: any, axiosInstance: AxiosInstance): Promise<VersioningResult> {
    const whoAmIResponse = await axiosInstance.get('/whoAmI');
    if (whoAmIResponse.status !== 200) {
        throw new Error("Failed to retrieve current user information for versioning check.");
    }
    const agentId = whoAmIResponse.data?.User?.Id;
    if (!agentId) {
        throw new Error("Could not retrieve the current user's ID to perform a versioning check.");
    }

    const isCheckedOut = item?.LockInfo?.LockType?.includes('CheckedOut');
    const checkedOutUser = item?.VersionInfo?.CheckOutUser?.IdRef;
    const restItemId = itemId.replace(':', '_');

    if (isCheckedOut && checkedOutUser !== agentId) {
        return {
            item: item,
            wasCheckedOutByTool: false,
            error: `Item ${itemId} is already checked out by another user (${checkedOutUser}). Operation aborted.`
        };
    }

    if (!isCheckedOut) {
        const checkOutResponse = await axiosInstance.post(`/items/${restItemId}/checkOut`, { "$type": "CheckOutRequest", "SetPermanentLock": true });
        if (checkOutResponse.status !== 200) {
            const unexpectedResponse = handleUnexpectedResponse(checkOutResponse);
            const errorText = unexpectedResponse.content?.[0]?.text || `Failed to check out item ${itemId}.`;
            throw new Error(errorText);
        }
        return {
            item: checkOutResponse.data,
            wasCheckedOutByTool: true,
            error: undefined
        };
    }

    // Already checked out by the current user
    return {
        item: item,
        wasCheckedOutByTool: false,
        error: undefined
    };
}


/**
 * Checks in a versioned item.
 * @param itemId The TCM URI of the item to check in.
 * @param axiosInstance An authenticated Axios instance.
 * @returns The Axios response from the check-in operation.
 */
export async function checkInItem(itemId: string, axiosInstance: AxiosInstance) {
    const restItemId = itemId.replace(':', '_');
    const checkInResponse = await axiosInstance.post(`/items/${restItemId}/checkIn`, { "$type": "CheckInRequest", "RemovePermanentLock": true });
    if (checkInResponse.status !== 200) {
        return handleUnexpectedResponse(checkInResponse);
    }
    return checkInResponse;
}

/**
 * Undoes the check-out for a versioned item. Typically used in error-handling scenarios.
 * @param itemId The TCM URI of the item.
 * @param axiosInstance An authenticated Axios instance.
 */
export async function undoCheckoutItem(itemId: string, axiosInstance: AxiosInstance): Promise<void> {
    const restItemId = itemId.replace(':', '_');
    try {
        await axiosInstance.post(`/items/${restItemId}/undoCheckOut`);
    } catch (undoError) {
        // Log the critical failure but don't re-throw, as this is part of a larger error handling block.
        console.error(`CRITICAL: Failed to undo checkout for item ${itemId}: ${String(undoError)}`);
    }
}