// lists_page_handler.js

(function () {
    let isUserLoggedIn = false;
    let currentUserId = null;
    let currentUserListId = null;

    // --- DOM Selectors (Updated based on provided HTML) ---
    const LIST_ITEM_SELECTOR = ".ipc-metadata-list-summary-item"; // Each list card/entry
    const LIST_LINK_SELECTOR = "a.ipc-metadata-list-summary-item__t"; // The link containing list ID and title
    // BUTTON_INJECTION_POINT_SELECTOR is no longer the direct parent for the button, linkElement (LIST_LINK_SELECTOR) is.
    const SEENLIST_BUTTON_CLASS = "seenlist-button";

    // --- Initialization ---
    async function initialize() {
        try {
            const initialState = await browser.runtime.sendMessage({action: "getInitialStatus"});
            if (initialState) {
                isUserLoggedIn = initialState.isLoggedIn;
                currentUserListId = initialState.listId;
                currentUserId = initialState.userId;
            } else {
                console.warn("Lists Handler: Did not receive initial state from background.");
                isUserLoggedIn = false;
            }
        } catch (error) {
            console.error("Lists Handler: Error requesting initial state:", error);
            isUserLoggedIn = false;
        }

        if (isUserLoggedIn) {
            injectButtonsIntoLists();
        } else {
            removeAllSeenListButtons();
        }
    }

    // --- Message Listener for State Updates ---
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "extensionStateUpdated") {
            const previousLoginState = isUserLoggedIn;
            const previousListId = currentUserListId;

            isUserLoggedIn = message.data.isLoggedIn;
            currentUserId = message.data.userId;
            currentUserListId = message.data.listId;

            if (isUserLoggedIn) {
                if (!previousLoginState) {
                    injectButtonsIntoLists();
                } else if (previousListId !== currentUserListId) {
                    updateAllButtonStates();
                } else {
                    updateAllButtonStates();
                }
            } else {
                removeAllSeenListButtons();
            }
            sendResponse({status: "processed by lists_page_handler"});
            return;
        }
    });

    // --- DOM Manipulation ---
    function injectButtonsIntoLists() {
        if (!isUserLoggedIn) {
            return;
        }

        const pageUserId = getUserIdFromUrl();
        if (pageUserId !== currentUserId) {
            removeAllSeenListButtons(); // Ensure no buttons are present on other users' pages
            return;
        }

        if (!document.querySelector(LIST_ITEM_SELECTOR)) {
            console.warn(`Lists Handler: (Inject) No list items found with selector '${LIST_ITEM_SELECTOR}'. Cannot inject buttons.`);
            return;
        }

        const listElements = document.querySelectorAll(LIST_ITEM_SELECTOR);

        listElements.forEach(listElement => {
            // Check if button already exists in the list item to prevent duplicates.
            if (listElement.querySelector("." + SEENLIST_BUTTON_CLASS)) {
                // We will update its state later in updateAllButtonStates if needed.
                return;
            }

            const linkElement = listElement.querySelector(LIST_LINK_SELECTOR);
            if (!linkElement || !linkElement.href) {
                console.warn("Lists Handler: (Inject) Could not find link or href for list ID in:", listElement);
                return;
            }

            const listId = extractListIdFromUrl(linkElement.href);
            if (!listId) {
                console.warn("Lists Handler: (Inject) Could not extract list ID from URL:", linkElement.href);
                return;
            }

            const button = document.createElement("button");
            button.classList.add(SEENLIST_BUTTON_CLASS);
            button.dataset.listId = listId;

            button.addEventListener("click", async (event) => {
                event.preventDefault();
                event.stopPropagation(); // Crucial: Prevents the link navigation

                if (!isUserLoggedIn) {
                    alert("Please log in to IMDb to set a SeenList.");
                    removeAllSeenListButtons();
                    return;
                }

                if (button.classList.contains("seenlist-button-active")) {
                    return;
                }

                if (!listId || !listId.startsWith("ls")) {
                    console.error("Lists Handler: (Click) Invalid list ID format for setting:", listId);
                    alert("Cannot set an invalid list ID.");
                    return;
                }

                button.disabled = true;
                button.textContent = "Saving...";

                try {
                    const response = await browser.runtime.sendMessage({
                        action: "setListId",
                        data: {listId: listId}
                    });
                    if (response && response.success) {
                    } else {
                        console.error("Lists Handler: (Click) Failed to set list ID via background script.", response ? response.error : "No response");
                        alert(`Failed to set list: ${response && response.error ? response.error : 'Unknown error'}`);
                        updateAllButtonStates();
                    }
                } catch (error) {
                    console.error("Lists Handler: (Click) Error sending setListId message:", error);
                    alert(`Error setting list: ${error.message}`);
                    updateAllButtonStates();
                }
            });

            // Append the button directly inside the <a> tag (linkElement)
            linkElement.appendChild(button);

        });
        updateAllButtonStates();
    }

    function updateAllButtonStates() {
        if (!isUserLoggedIn) {
            removeAllSeenListButtons();
            return;
        }

        const allButtons = document.querySelectorAll("." + SEENLIST_BUTTON_CLASS);
        allButtons.forEach(button => {
            const buttonListId = button.dataset.listId;
            button.disabled = false;
            button.classList.remove("seenlist-button-disabled");

            if (buttonListId === currentUserListId) {
                button.textContent = "Current SeenList ✓";
                button.classList.add("seenlist-button-active");
            } else {
                button.textContent = "Set as SeenList";
                button.classList.remove("seenlist-button-active");
            }
            if (button.textContent === "Saving...") {
                console.warn(`Lists Handler: (UpdateButtons) Button for ${buttonListId} was 'Saving...', updated. New text: ${button.textContent}`);
            }
        });
    }

    function removeAllSeenListButtons() {
        const allButtons = document.querySelectorAll("." + SEENLIST_BUTTON_CLASS);
        if (allButtons.length > 0) {
            allButtons.forEach(button => button.remove());
        }
    }

    // --- Utility Functions ---
    function extractListIdFromUrl(url) {
        if (!url) return null;
        const match = url.match(/\/list\/(ls\d+)/);
        return match ? match[1] : null;
    }

    function getUserIdFromUrl() {
        const match = window.location.pathname.match(/\/user\/(ur\d+)\//);
        return match ? match[1] : null;
    }

    // --- Run ---
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize);
    } else {
        initialize();
    }

})();