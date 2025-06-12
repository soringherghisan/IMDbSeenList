// --- CONFIGURATION & CONSTANTS ---
const DEBUG = false;
const API_URL = "https://api.graphql.imdb.com/";
const IMDB_CLIENT_NAME = "imdb-web-next-localized";

const SELECTORS = {
    MOVIE_ELEMENTS: ".ipc-poster, .ipc-poster-card",
    RIBBON_OVERLAY: ".seen-ribbon"
};

const RIBBON_SIZE_BREAKPOINTS = {
    COMPACT_MAX_WIDTH: 119,
    MEDIUM_MAX_WIDTH: 219
};
// --- END CONFIGURATION & CONSTANTS ---

let isUserLoggedIn = false;
let currentUserId = null;
let currentUserListId = null;

let seenMoviesCache = new Map(); // Cache for seen movies. movieId -> count

function debugLog(...args) {
    if (DEBUG) {
        console.log("[IMDb Seen List]:", ...args);
    }
}

/**
 * Extracts a movie ID (tconst) from a poster element's link.
 * Returns the tconst if found, otherwise null.
 * This ensures we only target actual movies/shows, not actors or other entities.
 * @param {HTMLElement} element The poster element.
 * @returns {string|null}
 */
function extractMovieIdFromElement(element) {
    // The poster element itself or a child 'a' tag should contain the link
    const linkElement = element.tagName === 'A' ? element : element.querySelector('a');
    if (linkElement && linkElement.href) {
        const match = linkElement.href.match(/\/title\/(tt\d+)/);
        if (match && match[1]) {
            return match[1]; // e.g., "tt0111161"
        }
    }
    return null;
}


// Function to fetch and cache movies in our list
async function updateSeenMoviesCache() {
    // First verify the user is logged in
    if (!isUserLoggedIn) {
        debugLog("Cannot update seen movies cache: User is not logged in (verified via cookie check)");
        seenMoviesCache.clear(); // Clear cache if user is not logged in
        processMovieElements(); // Update UI
        return false;
    }

    if (!currentUserListId) {
        debugLog("Cannot update seen movies cache: No List ID configured.");
        seenMoviesCache.clear(); // Clear cache if no list ID
        processMovieElements(); // Re-process to remove ribbons if list became invalid
        return false;
    }

    debugLog(`Starting cache update for list ${currentUserListId}...`);
    seenMoviesCache.clear(); // Clear cache before repopulating with all items

    let hasNextPage = true;
    let afterCursor = null;
    let fetchedItemsCount = 0;

    try {
        while (hasNextPage) {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-imdb-client-name": IMDB_CLIENT_NAME,
                },
                body: JSON.stringify({
                    query: GQL_QUERIES.getListItems,
                    variables: {listId: currentUserListId, afterCursor: afterCursor},
                }),
                credentials: "include",
            });

            const data = await response.json();

            if (data.errors) {
                console.error("GraphQL errors during cache update. Full error details:", JSON.stringify(data.errors, null, 2));
                data.errors.forEach((error, index) => {
                    console.error(`Error ${index + 1} message:`, error.message);
                    if (error.extensions) {
                        console.error(`Error ${index + 1} extensions:`, JSON.stringify(error.extensions, null, 2));
                    }
                });

                // Check if this is an authentication error
                const errorMessage = data.errors[0]?.message || "";
                if (errorMessage.includes("Authentication required") ||
                    errorMessage.includes("FORBIDDEN") ||
                    errorMessage.includes("Permission denied")) {
                    debugLog("Cache update failed due to authentication error. User likely logged out.");
                }
                seenMoviesCache.clear(); // Clear cache on error
                processMovieElements();
                return false;
            }

            const listData = data?.data?.list;
            if (!listData || !listData.items || !listData.items.edges) {
                console.error("Invalid response structure for cache update:", data);
                seenMoviesCache.clear();
                processMovieElements();
                return false;
            }

            listData.items.edges.forEach((edge) => {
                let titleId = null;
                if (edge?.node?.listItem?.__typename === 'Title') {
                    titleId = edge.node.listItem.id;
                }

                if (titleId && titleId.startsWith("tt")) {
                    seenMoviesCache.set(titleId, (seenMoviesCache.get(titleId) || 0) + 1);
                    fetchedItemsCount++;
                }
            });

            if (listData.items.pageInfo) {
                hasNextPage = listData.items.pageInfo.hasNextPage;
                afterCursor = listData.items.pageInfo.endCursor;
                // debugLog(`Fetched a page. hasNextPage: ${hasNextPage}, nextCursor: ${afterCursor}`);
            } else {
                hasNextPage = false; // No pageInfo, assume no more pages
            }
        }

        debugLog(
            `Cache updated successfully for list ${currentUserListId}. Total movies in cache: ${seenMoviesCache.size} (fetched ${fetchedItemsCount} new items/references). Movies:`,
            Array.from(seenMoviesCache.keys())
        );
        processMovieElements(); // Re-process elements once the cache is fully updated
        return true;

    } catch (error) {
        console.error("Failed to update seen movies cache during pagination:", error);
        seenMoviesCache.clear(); // Clear cache on significant error
        processMovieElements();
        return false;
    }
}

// Update check functions
function isMovieInList(movieId) {
    if (!currentUserListId) return false; // Not in list if no list is configured
    return (seenMoviesCache.get(movieId) || 0) > 0;
}

// List manipulation functions
async function addToList(movieId) {
    // Verify login status before attempting API call
    if (!isUserLoggedIn) {
        debugLog("Cannot add to list: User is not logged in.");
        showTemporaryRibbonError(movieId, "Not logged in");
        seenMoviesCache.clear(); // Clear cache since user isn't logged in
        processMovieElements(); // Update UI
        return false;
    }

    if (!currentUserListId) {
        debugLog("Cannot add to list: No List ID configured.");
        // Optionally, alert the user or provide feedback on the ribbon itself
        return false;
    }

    try {
        const requestBody = {
            query: GQL_QUERIES.addToList,
            variables: {
                input: {
                    listId: currentUserListId,
                    item: {
                        itemElementId: movieId
                    }
                }
            },
        };

        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-imdb-client-name": IMDB_CLIENT_NAME,
            },
            credentials: "include",
            body: JSON.stringify(requestBody),
        });

        const result = await response.json();

        if (result.errors) {
            console.error("GraphQL errors on addToList:", result.errors);
            const errorMessage = result.errors[0]?.message || "Unknown GraphQL error";

            // Handle login-related errors specifically
            if (errorMessage.includes("Authentication required") ||
                errorMessage.includes("FORBIDDEN") ||
                errorMessage.includes("Permission denied")) {
                debugLog("API call failed due to authentication error. User likely logged out in another tab.");
                // Force reload of user state
                currentUserId = null;
                currentUserListId = null;
                seenMoviesCache.clear();
                processMovieElements();
                showTemporaryRibbonError(movieId, "Not logged in");
                return false;
            }

            // Handle other errors
            if (errorMessage.includes("NOT_FOUND") || errorMessage.includes("Invalid list")) {
                showTemporaryRibbonError(movieId, "Invalid List ID?");
            }
            throw new Error(errorMessage);
        }

        // Rest of function remains the same
        if (!result.data || !result.data.addItemToList || !result.data.addItemToList.listId) {
            console.error("Add to list mutation did not return expected data structure:", result);
            throw new Error("Add to list mutation failed to return expected data.");
        }

        const newCount = (seenMoviesCache.get(movieId) || 0) + 1;
        seenMoviesCache.set(movieId, newCount);

        return true;
    } catch (error) {
        console.error("Failed to add movie to list:", error);
        return false;
    }
}

async function removeFromList(movieId) {
    // Verify login status before attempting API call
    if (!isUserLoggedIn) {
        debugLog("Cannot remove from list: User is not logged in.");
        showTemporaryRibbonError(movieId, "Not logged in.");
        seenMoviesCache.clear(); // Clear cache since user isn't logged in
        processMovieElements(); // Update UI
        return false;
    }

    if (!currentUserListId) {
        debugLog("Cannot remove from list: No List ID configured.");
        return false;
    }

    // Rest of function remains the same
    let itemIdToRemove = null;
    let hasNextPage = true;
    let afterCursor = null;

    try {
        // Loop to find the itemId for the given movieId (tconst)
        debugLog(`Searching for itemId for movieId (tconst): ${movieId} in list: ${currentUserListId} by paginating...`);
        while (hasNextPage && !itemIdToRemove) {
            const listItemsResponse = await fetch(API_URL, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-imdb-client-name": IMDB_CLIENT_NAME,
                },
                credentials: "include",
                body: JSON.stringify({
                    query: GQL_QUERIES.getListItemsForRemoval,
                    variables: {listId: currentUserListId, afterCursor: afterCursor},
                }),
            });

            const listData = await listItemsResponse.json();

            if (listData.errors) {
                console.error("GraphQL errors during paginated list item fetch for removal:", listData.errors);

                // Handle login-related errors specifically
                const errorMessage = listData.errors[0]?.message || "";
                if (errorMessage.includes("Authentication required") ||
                    errorMessage.includes("FORBIDDEN") ||
                    errorMessage.includes("Permission denied")) {
                    debugLog("API call failed due to authentication error. User likely logged out in another tab.");
                    // Force reload of user state
                    currentUserId = null;
                    currentUserListId = null;
                    seenMoviesCache.clear();
                    processMovieElements();
                    showTemporaryRibbonError(movieId, "Not logged in");
                    return false;
                }

                if (listData.errors[0] && listData.errors[0].message.includes("NOT_FOUND")) {
                    showTemporaryRibbonError(movieId, "Invalid List ID?");
                }
                return false; // Stop if there's an error
            }

            const itemsData = listData?.data?.list?.items;
            if (!itemsData || !itemsData.edges) {
                console.error("Invalid response structure fetching paginated list items for removal:", listData);
                return false; // Stop on invalid structure
            }

            for (const edge of itemsData.edges) {
                if (
                    edge?.node?.listItem?.__typename === 'Title' &&
                    edge.node.listItem.id === movieId
                ) {
                    itemIdToRemove = edge.node.itemId;
                    debugLog(`Found itemId: ${itemIdToRemove} for movieId (tconst): ${movieId}`);
                    break; // Exit loop once itemId is found
                }
            }

            if (itemsData.pageInfo) {
                hasNextPage = itemsData.pageInfo.hasNextPage;
                afterCursor = itemsData.pageInfo.endCursor;
            } else {
                hasNextPage = false; // No pageInfo, assume no more pages
            }

            if (itemIdToRemove) { // If found, no need to fetch more pages
                hasNextPage = false;
            }
        } // End of while loop for finding itemId

        if (!itemIdToRemove) {
            debugLog(`Could not find itemId for movieId (tconst): ${movieId} in the list after checking all pages. It might have been already removed.`);
            // If not found in list, ensure cache reflects this for this specific movie
            if (seenMoviesCache.has(movieId)) {
                seenMoviesCache.delete(movieId);
                debugLog(`Cache entry for ${movieId} cleared as its itemId was not found in the list for removal.`);
                const ribbonToUpdate = document.querySelector(`.seen-ribbon[data-movie-id="${movieId}"]`);
                if (ribbonToUpdate) ribbonToUpdate.classList.remove('is-seen');
            }
            return false; // Return false as the item wasn't (or couldn't be) removed via API if not found
        }

        // Proceed with removal using the found itemIdToRemove
        debugLog(`Proceeding to remove itemId: ${itemIdToRemove}`);
        const removeResponse = await fetch(API_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-imdb-client-name": IMDB_CLIENT_NAME,
            },
            credentials: "include",
            body: JSON.stringify({
                query: GQL_QUERIES.removeFromList,
                variables: {
                    input: {
                        listId: currentUserListId,
                        itemIds: [itemIdToRemove],
                    },
                },
            }),
        });

        const removeResult = await removeResponse.json();
        debugLog("Remove item mutation response:", removeResult);

        if (removeResult.errors) {
            console.error("GraphQL errors during removeItemsByItemIds mutation:", removeResult.errors);
            return false;
        }

        if (!removeResult.data || !removeResult.data.removeItemsByItemIds || !removeResult.data.removeItemsByItemIds.itemIds.includes(itemIdToRemove)) {
            debugLog(`Failed to confirm removal of itemId ${itemIdToRemove} via mutation response.`);
            // Consider if the item should be re-added to cache or if an error should be shown
        } else {
            debugLog(`Successfully removed itemId: ${itemIdToRemove} according to mutation response.`);
        }

        // Update local cache
        const currentCount = seenMoviesCache.get(movieId) || 0;
        if (currentCount > 0) {
            const newCount = currentCount - 1;
            if (newCount <= 0) {
                seenMoviesCache.delete(movieId);
                debugLog(`Movie ${movieId} (tconst) removed from cache (count reached zero).`);
            } else {
                seenMoviesCache.set(movieId, newCount);
                debugLog(`Movie ${movieId} (tconst) count decremented in cache to: ${newCount}.`);
            }
        }
        return true;
    } catch (error) {
        console.error("Exception in removeFromList:", error);
        return false;
    }
}


// Function to show a temporary error on the ribbon itself (optional visual feedback)
function showTemporaryRibbonError(movieId, message) {
    const ribbon = document.querySelector(`.seen-ribbon[data-movie-id="${movieId}"] .seen-ribbon__icon svg`);
    if (ribbon) {
        const originalContent = ribbon.innerHTML;
        // Simple text error - can be styled better or use a different icon
        ribbon.innerHTML = `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#FF0000" font-size="8px">Error</text>`;
        setTimeout(() => {
            // Attempt to re-evaluate state or revert
            const stillExists = document.querySelector(`.seen-ribbon[data-movie-id="${movieId}"]`);
            if (stillExists) {
                processSingleMovieElement(stillExists.parentElement); // Re-process the parent of this ribbon
            }
        }, 3000);
    }
    debugLog(`Ribbon error for ${movieId}: ${message}`);
}

function createSeenOverlay(movieId, isSeen, parentElementWidth) {
    const overlayElement = document.createElement("div");
    overlayElement.className = "seen-ribbon";
    overlayElement.dataset.movieId = movieId;

    // Handle the 3 states for the ribbon's appearance and tooltip
    if (!isUserLoggedIn) {
        // State 3: User is not logged in
        overlayElement.classList.add('seen-ribbon--disabled');
        overlayElement.title = "User is not logged in.";
    } else if (!currentUserListId) {
        // State 2: User is logged in, but no list ID is set
        overlayElement.classList.add('seen-ribbon--disabled');
        overlayElement.title = "No IMDb List ID configured. Please set one by going to the 'Your lists' page.";
    } else {
        // State 1: User is logged in and a list is configured
        overlayElement.title = isSeen ? "Mark as Unseen" : "Mark as Seen";
    }

    // Adjust ribbon size based on the parent element's width
    if (parentElementWidth <= RIBBON_SIZE_BREAKPOINTS.COMPACT_MAX_WIDTH) {
        overlayElement.classList.add('seen-ribbon--size-compact');
    } else if (parentElementWidth <= RIBBON_SIZE_BREAKPOINTS.MEDIUM_MAX_WIDTH) {
        overlayElement.classList.add('seen-ribbon--size-medium');
    } else {
        overlayElement.classList.add('seen-ribbon--size-large');
    }

    // Add the click event listener with logic for all 3 states
    overlayElement.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        // State 3: User is not logged in -> Redirect to the sign-in page
        if (!isUserLoggedIn) {
            debugLog("Ribbon click: User not logged in. Redirecting to login page.");
            window.location.href = "https://www.imdb.com/registration/signin";
            return;
        }

        // State 2: User is logged in, no list ID -> Show an alert
        if (!currentUserListId) {
            alert("No IMDb List ID configured. Please set one by going to the 'Your lists' page.");
            return;
        }

        // State 1: Main functionality (add/remove from list)
        const isCurrentlySeen = overlayElement.classList.contains("is-seen");

        // Optimistic UI update
        overlayElement.classList.toggle("is-seen");
        overlayElement.title = overlayElement.classList.contains("is-seen") ? "Mark as Unseen" : "Mark as Seen";

        let success;
        if (isCurrentlySeen) {
            success = await removeFromList(movieId);
        } else {
            success = await addToList(movieId);
        }

        if (!success) {
            // If the API call fails, revert the optimistic UI update
            debugLog(`Failed to toggle status for: ${movieId}. Reverting UI.`);
            overlayElement.classList.toggle("is-seen");
            overlayElement.title = overlayElement.classList.contains("is-seen") ? "Mark as Unseen" : "Mark as Seen";
        } else {
            debugLog(`Successfully toggled status for: ${movieId}`);
        }
    });

    if (isSeen) {
        overlayElement.classList.add('is-seen');
    }

    overlayElement.innerHTML = `
        <svg class="seen-ribbon__bg" viewBox="0 0 42 58" preserveAspectRatio="none">
            <polygon class="seen-ribbon__bg-shadow" points="0,0 42,0 42,58 21,48 0,58" transform="translate(1,1)"/>
            <polygon class="seen-ribbon__bg-ribbon" points="0,0 42,0 42,58 21,48 0,58"/>
            <polygon class="seen-ribbon__bg-hover" points="0,0 42,0 42,58 21,48 0,58"/>
        </svg>
        <div class="seen-ribbon__icon">
            <svg viewBox="0 0 24 24">
                <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
            </svg>
        </div>
    `;
    return overlayElement;
}

// Function to find and process movie elements
function processMovieElements() {
    try {
        const movieElements = document.querySelectorAll(SELECTORS.MOVIE_ELEMENTS);

        movieElements.forEach((element, index) => {
            processSingleMovieElement(element);
        });
    } catch (error) {
        console.error("Error in processMovieElements function itself:", error);
    }
}

function processSingleMovieElement(element) {
    if (!element || !element.matches(SELECTORS.MOVIE_ELEMENTS)) return;

    let movieIdForErrorLogging = "unknown";
    const elementIdForLog = element.id || `elem-single-${Math.random().toString(36).substring(2, 7)}`;

    try {
        const movieId = extractMovieIdFromElement(element);
        movieIdForErrorLogging = movieId || "extractedAsNull";

        if (!movieId) {
            return;
        }

        // Remove any existing overlay first to ensure clean state
        const existingOverlay = element.querySelector(`${SELECTORS.RIBBON_OVERLAY}[data-movie-id="${movieId}"]`);
        if (existingOverlay) {
            existingOverlay.remove();
        }

        const isSeen = currentUserListId ? isMovieInList(movieId) : false;
        const posterWidth = element.getBoundingClientRect().width;
        const overlay = createSeenOverlay(movieId, isSeen, posterWidth);

        if (!element.style.position || element.style.position === "static") {
            element.style.position = "relative";
        }
        element.appendChild(overlay);

    } catch (elementError) {
        console.error(`[${elementIdForLog}] Error processing single movie element (movieId: ${movieIdForErrorLogging}):`, elementError, "Element:", element);
    }
}


// Observer for dynamic content
const observer = new MutationObserver((mutationsList, observerInstance) => {
    let needsProcessing = false;
    for (let mutation of mutationsList) {
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if ((node.matches && node.matches(SELECTORS.MOVIE_ELEMENTS)) ||
                        (node.querySelector && node.querySelector(SELECTORS.MOVIE_ELEMENTS))) {
                        needsProcessing = true;
                    }
                }
            });
        }
        // If attributes of a poster change (e.g. data-tconst, or class that affects layout/visibility)
        if (mutation.type === "attributes" && mutation.target.matches && mutation.target.matches(SELECTORS.MOVIE_ELEMENTS)) {
            needsProcessing = true;
        }
    }
    if (needsProcessing) {
        processMovieElements();
    }
});


// --- MESSAGE LISTENER ---
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    debugLog("Message received in content script:", message);

    if (message.action === "extensionStateUpdated") {
        debugLog("content.js: Received extensionStateUpdated with data:", message.data);

        const oldListId = currentUserListId;
        const oldLoginState = isUserLoggedIn;
        const oldUserId = currentUserId;

        // Update local state variables from the message
        isUserLoggedIn = message.data.isLoggedIn;
        currentUserId = message.data.userId;
        currentUserListId = message.data.listId;

        debugLog(`content.js: State updated - LoggedIn: ${isUserLoggedIn}, UserID: ${currentUserId}, ListID: ${currentUserListId}`);

        // Check if there was a meaningful change that requires action
        const loginStateChanged = oldLoginState !== isUserLoggedIn;
        const userIdChanged = oldUserId !== currentUserId;
        const listIdChanged = oldListId !== currentUserListId;

        if (loginStateChanged || userIdChanged || listIdChanged) {
            debugLog("content.js: Detected change in login state, user ID, or list ID.");

            if (isUserLoggedIn && currentUserListId) {
                // User is logged in and has a list ID.
                // If the list ID changed, or if the user just logged in (and now has a list),
                // or if user ID changed (implies new user, new list context),
                // then update the cache.
                debugLog("content.js: User logged in with a list. Updating seen movies cache.");
                await updateSeenMoviesCache();
            } else {
                // User is not logged in, or no list ID is configured.
                // Clear the cache and re-process elements to reflect the logged-out/no-list state.
                debugLog("content.js: User not logged in or no list ID. Clearing cache and updating UI.");
                seenMoviesCache.clear();
                processMovieElements();
            }
        } else {
            debugLog("content.js: State update received, but no effective change to login/list status for UI/cache purposes.");
        }

        return true;
    }

    return false;
});


// Main execution
async function main() {
    debugLog("Content Script: Main - Starting initialization...");

    // 1. Fetch initial state from background.js
    try {
        const initialState = await browser.runtime.sendMessage({action: "getInitialStatus"});
        if (initialState) {
            debugLog("Content Script: Main - Initial state received from background.js:", initialState);
            isUserLoggedIn = initialState.isLoggedIn;
            currentUserId = initialState.userId;
            currentUserListId = initialState.listId;
        } else {
            debugLog("Content Script: Main - Did not receive initial state from background.js. Assuming logged out.");
            isUserLoggedIn = false;
            currentUserId = null;
            currentUserListId = null;
        }
    } catch (error) {
        console.error("Content Script: Main - Error requesting initial state from background.js:", error);
        debugLog("Content Script: Main - Error requesting initial state. Assuming logged out.");
        isUserLoggedIn = false;
        currentUserId = null;
        currentUserListId = null;
    }

    debugLog(`Content Script: Main - Initialization state set: LoggedIn=${isUserLoggedIn}, UserID=${currentUserId}, ListID=${currentUserListId}`);

    // 2. Conditional cache update and UI processing
    if (isUserLoggedIn && currentUserListId) {
        debugLog("Content Script: Main - User is logged in and has a List ID. Updating seen movies cache.");
        await updateSeenMoviesCache();
    } else {
        debugLog("Content Script: Main - User not logged in or no List ID. Clearing cache and processing elements for initial UI.");
        seenMoviesCache.clear();
        processMovieElements(); // Ensure UI reflects logged-out/no-list state
    }

    // 3. Start the MutationObserver
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id', 'class', 'data-tconst']
    });
    debugLog("Content Script: Main - Mutation observer started.");
    debugLog("Content Script: Main - Initialization complete.");
}


// Ensure GQL_QUERIES is loaded before running main
if (typeof GQL_QUERIES !== 'undefined') {
    main();
} else {
    console.error("[IMDb Seen List]: GQL_QUERIES is not defined. Ensure graphql_queries.js is loaded before content.js.");
}