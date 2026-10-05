document.addEventListener("DOMContentLoaded", () => {
    // Get DOM elements
    const currentSiteSpan = document.getElementById("currentSite");
    const loginStatusContainer = document.querySelector(".login-status");
    // Assuming .username-line wraps the user info part of the login status
    const userInfoLine = document.querySelector(".username-line");
    const currentListContainer = document.querySelector(".current-list"); // The whole div for current list
    
    const loginStatusSpan = document.getElementById("loginStatus");
    const userInfoSpan = document.getElementById("userInfo");
    const currentListDiv = document.getElementById("currentListValue");

    // --- UI Update Functions ---
    function updateLoginStatusUI(isLoggedIn, userId) {
        if (isLoggedIn && userId) {
            loginStatusSpan.textContent = "Logged in ✅";
            loginStatusSpan.className = "status-success";
            userInfoSpan.textContent = userId;
            userInfoSpan.className = "status-success";
            if (userInfoLine) userInfoLine.style.display = "block"; // Show user ID line
        } else if (isLoggedIn) {
            // Logged in, but the user ID couldn't be determined (IMDb may have changed its cookies/page data)
            loginStatusSpan.textContent = "Logged in, but user ID not found ⚠️";
            loginStatusSpan.className = "status-error";
            userInfoSpan.textContent = "N/A";
            userInfoSpan.className = "status-error";
            if (userInfoLine) userInfoLine.style.display = "block";
        } else {
            loginStatusSpan.textContent = "Not logged in ❌";
            loginStatusSpan.className = "status-error";
            userInfoSpan.textContent = "N/A";
            userInfoSpan.className = "status-error";
            if (userInfoLine) userInfoLine.style.display = "none";
        }
    }

    function updateCurrentListUI(listId, isLoggedIn) {
        // This function will only be called if we are on IMDb,
        // so we primarily care about login status and listId presence.
        if (!isLoggedIn) {
            currentListDiv.textContent = "Login to IMDb to see your list ID.";
            currentListDiv.style.fontStyle = "italic";
            currentListDiv.style.color = "#666";
        } else if (listId) {
            currentListDiv.textContent = listId;
            currentListDiv.style.fontStyle = "normal";
            currentListDiv.style.color = "#000"; 
        } else {
            currentListDiv.textContent = "No list ID configured for this user.";
            currentListDiv.style.fontStyle = "italic";
            currentListDiv.style.color = "#666";
        }
    }

    async function requestAndUpdateDisplayForIMDb() {
        try {
            const status = await browser.runtime.sendMessage({ action: "getInitialStatus" });
            if (status) {
                updateLoginStatusUI(status.isLoggedIn, status.userId);
                updateCurrentListUI(status.listId, status.isLoggedIn);
            } else {
                console.error("Popup: Did not receive a valid status from background.js on initial request.");
                updateLoginStatusUI(false, null);
                updateCurrentListUI(null, false);
            }
        } catch (error) {
            console.error("Popup: Error requesting initial status from background.js:", error);
            updateLoginStatusUI(false, null);
            updateCurrentListUI(null, false);
        }
    }

    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        let onIMDb = false;
        if (tabs && tabs.length > 0 && tabs[0].url) {
            const url = tabs[0].url;
            try {
                const hostname = new URL(url).hostname;
                if (hostname.includes("imdb.com")) {
                    onIMDb = true;
                }
            } catch (e) {
                // Invalid URL (e.g. "about:blank"), treat as not on IMDb
                onIMDb = false;
            }
        } // else, no URL or error, onIMDb remains false

        if (onIMDb) {
            currentSiteSpan.textContent = "On IMDb.com 😊";
            currentSiteSpan.style.color = "#4CAF50";
            if (loginStatusContainer) loginStatusContainer.style.display = "block";
            if (currentListContainer) currentListContainer.style.display = "block";
            requestAndUpdateDisplayForIMDb();
        } else {
            currentSiteSpan.textContent = "Not on IMDb.com ☹️";
            currentSiteSpan.style.color = "#cc0000";
            // Hide all IMDb-specific info sections
            if (loginStatusContainer) loginStatusContainer.style.display = "none";
            if (currentListContainer) currentListContainer.style.display = "none";
            // No need to set currentListDiv text if the whole container is hidden
        }
    }).catch(error => {
        console.error("Popup: Error querying tabs:", error);
        currentSiteSpan.textContent = "Not on IMDb.com ☹️"; // Default to not on IMDb on error
        currentSiteSpan.style.color = "#cc0000";
        if (loginStatusContainer) loginStatusContainer.style.display = "none";
        if (currentListContainer) currentListContainer.style.display = "none";
    });

    // Listener for updates from background script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "extensionStateUpdated") {
            // Check again if on IMDb before updating, in case the tab changed
            // since the popup was opened.
            browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
                let onIMDbCurrently = false;
                if (tabs && tabs.length > 0 && tabs[0].url) {
                    try {
                        const hostname = new URL(tabs[0].url).hostname;
                        if (hostname.includes("imdb.com")) {
                            onIMDbCurrently = true;
                        }
                    } catch (e) { /* ignore, onIMDbCurrently remains false */ }
                }
                
                if (onIMDbCurrently) {
                    // Ensure sections are visible if they were hidden
                    if (loginStatusContainer && loginStatusContainer.style.display === "none") {
                        loginStatusContainer.style.display = "block";
                    }
                    if (currentListContainer && currentListContainer.style.display === "none") {
                        currentListContainer.style.display = "block";
                    }
                    updateLoginStatusUI(message.data.isLoggedIn, message.data.userId);
                    updateCurrentListUI(message.data.listId, message.data.isLoggedIn);
                } else {
                    // If not on IMDb, ensure IMDb-specific sections are hidden
                    if (loginStatusContainer) loginStatusContainer.style.display = "none";
                    if (currentListContainer) currentListContainer.style.display = "none";
                    currentSiteSpan.textContent = "Not on IMDb.com ☹️";
                    currentSiteSpan.style.color = "#cc0000";
                }
            });
        }
    });
});