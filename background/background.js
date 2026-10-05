// background.js

// Global state variables
let isUserLoggedIn = false;
let currentUserId = null;
let currentUserListId = null;

// Login state as reported by IMDb's own page data (see readPageAccountState in content.js).
// Used as a fallback when the cookies alone can't tell us who is logged in.
let pageAccountState = null;

const IMDB_DOMAIN = "imdb.com";
// Any of these cookies indicates a signed-in IMDb (Amazon) session.
const AUTH_COOKIE_NAMES = ["x-main", "at-main", "sess-at-main"];
const USER_COOKIE_NAME = "uu";
const USER_ID_PATTERN = /^ur\d+$/;

// Initialize state when the background script starts
// Store the promise for later use, ensuring we wait for full initialization.
const initialisationPromise = updateUserStateAndNotify("background_script_startup")
    .catch(err => {
        console.error("Background: Error during initial user state determination on startup:", err);
        // Potentially re-throw or handle critical init failure
        // For now, the promise will be rejected, and getInitialStatus can handle it.
    });


// --- Cookie Helpers ---
async function getImdbCookies() {
    try {
        // partitionKey: {} also returns partitioned cookies; firstPartyDomain: null keeps the
        // query working when first-party isolation is enabled.
        const cookies = await browser.cookies.getAll({domain: IMDB_DOMAIN, partitionKey: {}, firstPartyDomain: null});
        // Ignore cookies partitioned under other sites (e.g. IMDb embeds), they don't reflect the imdb.com session.
        return cookies.filter(cookie => !cookie.partitionKey || !cookie.partitionKey.topLevelSite ||
            cookie.partitionKey.topLevelSite.endsWith(IMDB_DOMAIN));
    } catch (error) {
        console.warn("Background: Extended cookie query failed, retrying with a basic one:", error.message);
        return await browser.cookies.getAll({domain: IMDB_DOMAIN});
    }
}

// Recursively looks for a user ID string (e.g. "ur12345678") inside a parsed object.
function findUserIdInObject(value, depth = 0) {
    if (typeof value === "string") return USER_ID_PATTERN.test(value) ? value : null;
    if (!value || typeof value !== "object" || depth > 4) return null;
    for (const child of Object.values(value)) {
        const found = findUserIdInObject(child, depth + 1);
        if (found) return found;
    }
    return null;
}

// The 'uu' cookie has historically been base64-encoded JSON holding the user ID in 'uc'.
// Parse it leniently so small format changes (quoting, URL-encoding, base64url, renamed keys) don't break us.
function parseUserIdFromUuCookie(rawValue) {
    let value = rawValue.replace(/^"|"$/g, "");
    try {
        value = decodeURIComponent(value);
    } catch (error) { /* not URL-encoded */ }

    let decoded = value;
    try {
        const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
        decoded = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    } catch (error) { /* not base64, search the value as-is */ }

    try {
        const userData = JSON.parse(decoded);
        if (userData && typeof userData.uc === "string" && USER_ID_PATTERN.test(userData.uc)) return userData.uc;
        const found = findUserIdInObject(userData);
        if (found) return found;
    } catch (error) { /* not JSON */ }

    const match = decoded.match(/ur\d{4,}/);
    return match ? match[0] : null;
}


// --- Core State Update Function ---
async function updateUserStateAndNotify(reason = "Unknown") {
    const previousLoginState = isUserLoggedIn;
    const previousUserId = currentUserId;
    const previousListId = currentUserListId;

    let cookieLoginState = false;
    let cookieUserId = null;
    let cookieNames = [];
    let newRawListId = null;

    try {
        const cookies = await getImdbCookies();
        cookieNames = [...new Set(cookies.map(cookie => cookie.name))];
        const findCookie = name => cookies.find(cookie => cookie.name === name && cookie.value);

        cookieLoginState = AUTH_COOKIE_NAMES.some(findCookie);
        const uuCookie = findCookie(USER_COOKIE_NAME);
        if (uuCookie) {
            cookieUserId = parseUserIdFromUuCookie(uuCookie.value);
        }
    } catch (error) {
        console.error("Background: Error checking cookies:", error);
        cookieLoginState = previousLoginState;
        cookieUserId = previousUserId;
    }

    // Logged in if either the cookies or IMDb's page data say so. Prefer the cookie user ID, fall back to the page's.
    const pageSaysLoggedIn = !!(pageAccountState && pageAccountState.isLoggedIn);
    isUserLoggedIn = cookieLoginState || pageSaysLoggedIn;
    currentUserId = isUserLoggedIn ? (cookieUserId || (pageAccountState && pageAccountState.userId) || null) : null;

    // Cookie names only (never values), to help diagnose future IMDb changes.
    if ((pageAccountState && pageSaysLoggedIn !== cookieLoginState) || (isUserLoggedIn && !currentUserId)) {
        console.warn(`Background (${reason}): Login detection is incomplete or inconsistent, IMDb may have changed its cookies.`,
            {cookieLoginState, cookieUserId, pageAccountState, imdbCookieNames: cookieNames});
    }

    if (isUserLoggedIn && currentUserId) {
        const storageKey = `userListId_${currentUserId}`;
        try {
            const data = await browser.storage.local.get(storageKey);
            newRawListId = data[storageKey] || null;
        } catch (error) {
            console.error(`Background: Error loading list ID for user ${currentUserId}:`, error);
            newRawListId = previousListId;
        }
    } else {
        newRawListId = null;
    }
    currentUserListId = newRawListId;

    if (previousLoginState !== isUserLoggedIn || previousUserId !== currentUserId || previousListId !== currentUserListId) {
        notifyOtherPartsOfExtension();
    }
}

// --- Notification Function ---
function notifyOtherPartsOfExtension() {
    const statusPayload = {
        isLoggedIn: isUserLoggedIn,
        userId: currentUserId,
        listId: currentUserListId
    };

    browser.runtime.sendMessage({
        action: "extensionStateUpdated",
        data: statusPayload
    }).catch(e => {
        if (e.message.includes("Could not establish connection") || e.message.includes("Receiving end does not exist")) {
            // Common if popup is not open.
        } else {
            console.warn("Background: Error sending 'extensionStateUpdated' to popup:", e.message);
        }
    });

    browser.tabs.query({url: `*://*.${IMDB_DOMAIN}/*`}).then(tabs => {
        if (tabs && tabs.length > 0) {
            tabs.forEach(tab => {
                browser.tabs.sendMessage(tab.id, {
                    action: "extensionStateUpdated",
                    data: statusPayload
                }).catch(err => {
                    console.warn(`Background (notifyOtherParts): FAILED to send 'extensionStateUpdated' to tab ${tab.id} (URL: ${tab.url || 'N/A'}). Error: ${err.message ? err.message : JSON.stringify(err)}`);
                    // It's common for content scripts not to be ready or on a page that doesn't have the listener.
                    if (!err.message.includes("Receiving end does not exist") && !err.message.includes("Could not establish connection")) {
                        console.warn(`Background (notifyOtherParts): FAILED to send 'extensionStateUpdated' to tab ${tab.id} (URL: ${tab.url || 'N/A'}). Error: ${err.message ? err.message : JSON.stringify(err)}`);
                    }
                });
            });
        }
    }).catch(error => console.error("Background (notifyOtherParts): Error querying tabs for notification:", error.message));
}


// --- Event Listeners ---
browser.cookies.onChanged.addListener(async (changeInfo) => {
    const cookieName = changeInfo.cookie.name;
    const isAuthCookie = AUTH_COOKIE_NAMES.includes(cookieName);
    if (changeInfo.cookie.domain.includes(IMDB_DOMAIN) && (isAuthCookie || cookieName === USER_COOKIE_NAME)) {
        if (isAuthCookie && changeInfo.removed && changeInfo.cause !== "overwrite") {
            pageAccountState = null; // Signed out, the last page-reported state is stale
        }
        let reason = `Cookie '${cookieName}' ${changeInfo.removed ? 'removed' : 'changed/added'}`;
        await updateUserStateAndNotify(reason);
    }
});

browser.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === "local") {
        const listIdChangedKey = Object.keys(changes).find(key => key.startsWith("userListId_"));
        if (listIdChangedKey) {
            let reason = `storage.onChanged detected for key '${listIdChangedKey}'`;
            await updateUserStateAndNotify(reason);
        }
    }
});

// --- Message Listener (from popup or content scripts) ---
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "getInitialStatus") {
        (async () => {
            try {
                await initialisationPromise; // Wait for initialisation to complete
                const status = {
                    isLoggedIn: isUserLoggedIn,
                    userId: currentUserId,
                    listId: currentUserListId
                };
                sendResponse(status);
            } catch (error) {
                console.error("Background (getInitialStatus): Error during or after initialisationPromise:", error);
                sendResponse({
                    isLoggedIn: false,
                    userId: null,
                    listId: null,
                    error: "Failed to get initial status due to background error."
                });
            }
        })();
        return true; // Required for async sendResponse
    } else if (message.action === "reportPageAccountState") {
        (async () => {
            const data = message.data || {};
            if (typeof data.isLoggedIn !== "boolean") {
                sendResponse({success: false, error: "Invalid page account state."});
                return;
            }
            await initialisationPromise;
            pageAccountState = {
                isLoggedIn: data.isLoggedIn,
                userId: data.isLoggedIn && typeof data.userId === "string" && USER_ID_PATTERN.test(data.userId) ? data.userId : null
            };
            await updateUserStateAndNotify(`page account state reported by tab ${sender.tab ? sender.tab.id : 'N/A'}`);
            sendResponse({success: true});
        })();
        return true; // Required for async sendResponse
    } else if (message.action === "setListId") {
        (async () => {
            if (!isUserLoggedIn || !currentUserId) {
                console.error("Background (setListId): User not logged in or no user ID. Cannot set list ID.");
                sendResponse({
                    success: false,
                    error: "User not logged in or user ID is missing. Please refresh or re-login."
                });
                return;
            }

            const newListId = message.data && message.data.listId;
            if (typeof newListId !== 'string' || !newListId.startsWith("ls")) {
                console.error("Background (setListId): Invalid listId format or data structure. Received:", message.data);
                sendResponse({success: false, error: "Invalid list ID format provided."}); // This could be the source of your "Invalid data" error
                return;
            }

            const storageKey = `userListId_${currentUserId}`;
            try {
                await browser.storage.local.set({[storageKey]: newListId});
                // Note: currentUserListId will be updated via the storage.onChanged listener
                // which calls updateUserStateAndNotify, then notifyOtherPartsOfExtension.
                sendResponse({success: true});
            } catch (error) {
                console.error(`Background (setListId): Error saving list ID ${newListId} for user ${currentUserId}:`, error);
                sendResponse({success: false, error: `Failed to save list ID: ${error.message}`});
            }
        })();
        return true; // Required for async sendResponse
    }
});