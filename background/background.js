// background.js

// Global state variables
let isUserLoggedIn = false;
let currentUserId = null;
let currentUserListId = null;

const IMDB_COOKIE_URL = "https://www.imdb.com";
const IMDB_DOMAIN = "imdb.com";

// Initialize state when the background script starts
// Store the promise for later use, ensuring we wait for full initialization.
const initialisationPromise = updateUserStateAndNotify("background_script_startup")
    .catch(err => {
        console.error("Background: Error during initial user state determination on startup:", err);
        // Potentially re-throw or handle critical init failure
        // For now, the promise will be rejected, and getInitialStatus can handle it.
    });


// --- Core State Update Function ---
async function updateUserStateAndNotify(reason = "Unknown") {
    const previousLoginState = isUserLoggedIn;
    const previousUserId = currentUserId;
    const previousListId = currentUserListId;

    let newLoginState = false;
    let newUserId = null;
    let newRawListId = null;

    try {
        const xMainCookie = await browser.cookies.get({url: IMDB_COOKIE_URL, name: "x-main"});
        if (xMainCookie && xMainCookie.value) {
            newLoginState = true;
            const uuCookie = await browser.cookies.get({url: IMDB_COOKIE_URL, name: "uu"});
            if (uuCookie && uuCookie.value) {
                try {
                    const decodedValue = atob(uuCookie.value);
                    const userData = JSON.parse(decodedValue);
                    newUserId = userData.uc || null;
                } catch (error) {
                    console.error("Background: Error parsing 'uu' cookie:", error);
                    newUserId = null;
                }
            }
        }
    } catch (error) {
        console.error("Background: Error checking cookies:", error);
        newLoginState = previousLoginState;
        newUserId = previousUserId;
    }

    isUserLoggedIn = newLoginState;
    currentUserId = newUserId;

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
    if (changeInfo.cookie.domain.includes(IMDB_DOMAIN) && (changeInfo.cookie.name === "x-main" || changeInfo.cookie.name === "uu")) {
        let reason = `Cookie '${changeInfo.cookie.name}' ${changeInfo.removed ? 'removed' : 'changed/added'}`;
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