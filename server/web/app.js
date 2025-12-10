// API Configuration
const API_BASE = '/api';
let authToken = localStorage.getItem('authToken');
let currentUser = null;
let wsConnection = null;
let peerConnection = null;
let localStream = null;
let currentCall = null;
let audioOutputDevices = [];
let currentAudioOutputId = 'default'; // 'default' for speaker, 'earpiece' or device ID
let contactsRefreshInterval = null;

// i18n Configuration
let translations = {};
let currentLang = 'en';

// Detect browser language
function detectLanguage() {
    const browserLang = navigator.language || navigator.userLanguage;
    if (browserLang.startsWith('ru')) {
        return 'ru';
    }
    return 'en'; // Default to English
}

// Load translations
async function loadTranslations(lang) {
    try {
        console.log('[I18N] Loading translations for language:', lang);
        // Add cache-busting timestamp to prevent caching
        const timestamp = Date.now();
        const response = await fetch(`${API_BASE}/translations/${lang}?v=${timestamp}`);
        if (!response.ok) {
            console.error('[I18N] Failed to load translations');
            throw new Error('Failed to load translations');
        }

        const apiTranslations = await response.json();
        console.log('[I18N] API translations loaded, keys:', Object.keys(apiTranslations).length, 'sample keys:', Object.keys(apiTranslations).slice(0, 10));

        // Load translations in any case, even if incomplete
        if (!apiTranslations || Object.keys(apiTranslations).length === 0) {
            console.error('[I18N] API returned empty translations');
            throw new Error('Empty translations received');
        }

        // Set translations (even if incomplete)
        translations = apiTranslations;
        currentLang = lang;
        localStorage.setItem('preferredLanguage', lang);
        console.log('[I18N] Translations loaded successfully, total keys:', Object.keys(translations).length);
        applyTranslations();
    } catch (error) {
        console.error('[I18N] Error loading translations:', error);
        throw error; // Re-throw to let caller handle
    }
}


// Translate function
function t(key) {
    if (!translations || Object.keys(translations).length === 0) {
        return key;
    }
    return translations[key] || key;
}

// Apply translations to the page
function applyTranslations() {
    // Update HTML elements with data-i18n attributes
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = t(key);
        if (el.tagName === 'INPUT' && el.type === 'text') {
            el.placeholder = translation;
        } else {
            el.textContent = translation;
        }
    });

    // Update elements with data-i18n-placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
    });

    // Update language switcher
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
        langSelect.value = currentLang;
    }

    // Update title
    document.title = t('app_name');

    // Update HTML lang attribute
    document.documentElement.lang = currentLang;
}

// Switch language
async function switchLanguage(lang) {
    if (lang === currentLang) return;
    try {
        await loadTranslations(lang);
        currentLang = lang;
        localStorage.setItem('language', lang);
        
        // Update language selector
        const mobileLangSelect = document.getElementById('mobile-language-select');
        if (mobileLangSelect) {
            mobileLangSelect.value = lang;
        }
        
        // Reload contacts and other dynamic content to update translations
        if (currentUser) {
            await loadContacts();
            if (currentUser.is_first_user) {
                await loadPendingInvites();
            }
        }
    } catch (error) {
        console.error('[I18N] Failed to switch language:', error);
        // Retry with English as fallback
        if (lang !== 'en') {
            try {
                await loadTranslations('en');
                currentLang = 'en';
                localStorage.setItem('language', 'en');
            } catch (err) {
                console.error('[I18N] Failed to load English translations too:', err);
            }
        }
    }
}

// WebRTC Configuration - will be loaded from server
let rtcConfig = {
    iceServers: []
};

// Store ICE candidates that arrive before peer connection is ready
const pendingIceCandidates = [];

// Load TURN configuration from server
async function loadTURNConfig() {
    try {
        const url = `${API_BASE}/turn-config`;
        console.log('[TURN] Loading TURN configuration from:', url);

        const response = await fetch(url);
        console.log('[TURN] Response status:', response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[TURN] Failed to load TURN config, status:', response.status, errorText);
            // Don't return - try to use empty config
            return;
        }

        const data = await response.json();
        console.log('[TURN] API response received:', data);
        console.log('[TURN] Response keys:', Object.keys(data));

        // The API returns { iceServers: [...] }, so use that directly
        if (data.iceServers && Array.isArray(data.iceServers)) {
            rtcConfig = { iceServers: data.iceServers };
            console.log('[TURN] Configuration loaded successfully');
            console.log('[TURN] Number of ICE servers:', rtcConfig.iceServers.length);
            rtcConfig.iceServers.forEach((server, idx) => {
                console.log(`[TURN] ICE Server ${idx}:`, server);
            });
        } else {
            console.error('[TURN] Invalid config format - missing iceServers array. Data:', data);
            console.error('[TURN] Type of data:', typeof data);
            console.error('[TURN] Type of data.iceServers:', typeof data.iceServers);
        }
    } catch (error) {
        console.error('[TURN] Exception loading TURN config:', error);
        console.error('[TURN] Error stack:', error.stack);
    }
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    await initServiceWorker();

    // Load translations first - must complete before any UI operations
    const savedLang = localStorage.getItem('preferredLanguage') || detectLanguage();
    try {
        await loadTranslations(savedLang);
    } catch (error) {
        console.error('[I18N] Failed to load translations, retrying with English...');
        // Retry with English as fallback
        if (savedLang !== 'en') {
            try {
                await loadTranslations('en');
            } catch (err) {
                console.error('[I18N] Failed to load English translations too:', err);
                // Continue anyway - translations will show keys
            }
        }
    }

    // Check if we're opening from a call notification
    const urlParams = new URLSearchParams(window.location.search);
    const callerId = urlParams.get('caller_id');
    const callerName = urlParams.get('caller_name');
    const callType = urlParams.get('call_type');

    if (callerId && callerName && callType) {
        // Store call info to handle after auth
        sessionStorage.setItem('pendingCall', JSON.stringify({
            caller_id: callerId,
            caller_name: callerName,
            call_type: callType
        }));
        // Clean URL
        window.history.replaceState({}, '', '/');
    }

    await checkAuth();
    setupEventListeners();
    checkInstallPrompt();
});

// Service Worker Registration
async function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('/service-worker.js', {
                scope: '/',
                updateViaCache: 'none' // Prevent automatic cache-based updates
            });

            // Prevent automatic update checks that cause "site updated" messages
            // Only check for updates when user explicitly visits the page
            if (registration.update) {
                // Don't call registration.update() automatically
            }
            console.log('Service Worker registered:', registration);
            console.log('Service Worker scope:', registration.scope);
        } catch (error) {
            console.error('Service Worker registration failed:', error);
        }
    } else {
        console.warn('Service Worker not supported');
    }
}

// Show/hide loading spinner
function showLoading(text) {
    const spinner = document.getElementById('loading-spinner');
    if (!spinner) {
        // Element should always exist in DOM, but handle gracefully if it doesn't
        return;
    }
    const loadingText = spinner.querySelector('.loading-text');
    if (loadingText) {
        // Use translation if text is a key, otherwise use the text directly
        const displayText = text || t('loading');
        loadingText.textContent = displayText;
    }
    spinner.classList.remove('hidden');
}

function hideLoading() {
    const spinner = document.getElementById('loading-spinner');
    if (spinner) {
        spinner.classList.add('hidden');
    }
}

// Check authentication
async function checkAuth() {
    showLoading(t('checking_authentication'));

    // Reload token from localStorage in case it was updated
    authToken = localStorage.getItem('authToken');

    if (authToken) {
        console.log('Token found in localStorage, checking authentication...');
        try {
            await fetchUserInfo();
            console.log('Authentication successful');
        } catch (error) {
            // fetchUserInfo already handles showing login screen on error
            // But ensure we're showing it if not on invite page
            console.error('Authentication check failed:', error);
            const path = window.location.pathname;
            const inviteMatch = path.match(/\/invite\/([a-f0-9-]+)/i);
            if (!inviteMatch && !currentUser) {
                console.log('Showing login screen due to auth failure');
                showScreen('login-screen');
            }
        } finally {
            hideLoading();
        }
    } else {
        console.log('No token found in localStorage');
        // Check if we're on an invite page - handle that first
        const path = window.location.pathname;
        const inviteMatch = path.match(/\/invite\/([a-f0-9-]+)/i);
        if (!inviteMatch) {
            showScreen('login-screen');
        }
        hideLoading();
    }
}

// Setup event listeners
function setupEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', handleLogin);

    // Logout (in mobile menu)
    const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
    if (mobileLogoutBtn) {
        mobileLogoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeMobileMenu();
            handleLogout();
        });
    }

    // Language switcher (in mobile menu)
    const mobileLangSelect = document.getElementById('mobile-language-select');
    if (mobileLangSelect) {
        mobileLangSelect.value = currentLang;
        mobileLangSelect.addEventListener('change', async (e) => {
            await switchLanguage(e.target.value);
        });
    }
    
    // Backup button
    const backupBtn = document.getElementById('backup-btn');
    if (backupBtn) {
        backupBtn.addEventListener('click', handleBackup);
    }
    
    // Restore button
    const restoreBtn = document.getElementById('restore-btn');
    const restoreFileInput = document.getElementById('restore-file-input');
    if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
            if (restoreFileInput) restoreFileInput.click();
        });
    }
    if (restoreFileInput) {
        restoreFileInput.addEventListener('change', handleRestore);
    }
    
    // Mobile menu toggle
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', openMobileMenu);
    }
    
    const menuClose = document.getElementById('menu-close');
    if (menuClose) {
        menuClose.addEventListener('click', closeMobileMenu);
    }
    
    const menuOverlay = document.getElementById('mobile-menu-overlay');
    if (menuOverlay) {
        menuOverlay.addEventListener('click', closeMobileMenu);
    }

    // Add contact
    // Add contact button (only show for first user)
    const addContactBtn = document.getElementById('add-contact-btn');
    if (addContactBtn) {
        addContactBtn.addEventListener('click', () => {
            document.getElementById('add-contact-modal').classList.add('active');
        });
    }

    document.getElementById('add-contact-form').addEventListener('submit', handleAddContact);
    document.getElementById('cancel-contact-btn').addEventListener('click', () => {
        document.getElementById('add-contact-modal').classList.remove('active');
    });

    // Invite modal
    document.getElementById('copy-invite-btn').addEventListener('click', () => {
        const inviteLink = document.getElementById('invite-link');
        inviteLink.select();
        document.execCommand('copy');
        alert(t('link_copied'));
    });

    const shareBtn = document.getElementById('share-invite-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            const inviteLink = document.getElementById('invite-link').value;
            shareInviteLink(inviteLink);
        });
    }

    document.getElementById('close-invite-btn').addEventListener('click', () => {
        document.getElementById('invite-modal').classList.remove('active');
    });

    // Accept invite button
    document.getElementById('accept-invite-btn').addEventListener('click', acceptInvite);

    // Notification prompt buttons
    document.getElementById('enable-notifications-btn').addEventListener('click', requestNotificationPermission);
    document.getElementById('dismiss-notification-btn').addEventListener('click', () => {
        document.getElementById('notification-prompt').style.display = 'none';
        localStorage.setItem('notification-prompt-dismissed', 'true');
    });

    // Install app prompt buttons
    document.getElementById('install-app-btn').addEventListener('click', installApp);
    document.getElementById('dismiss-install-btn').addEventListener('click', () => {
        document.getElementById('install-app-prompt').style.display = 'none';
        localStorage.setItem('install-prompt-dismissed', 'true');
    });

    // Check if we're on an invite page
    checkInvitePage();

    // Install prompt
    const installBtn = document.getElementById('install-btn');
    if (installBtn) {
        installBtn.addEventListener('click', installApp);
    }

    // Show share button if Web Share API is supported
    if (navigator.share) {
        const shareInviteBtn = document.getElementById('share-invite-btn');
        if (shareInviteBtn) {
            shareInviteBtn.style.display = 'inline-block';
        }
    }

    // Service worker messages (not needed for URL-based notifications)
    // We're using URL parameters now, so service worker messages aren't used
}

// Handle login/register
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const errorEl = document.getElementById('login-error');

    if (!username) {
        showError(errorEl, 'Username is required');
        return;
    }

    try {
        showLoading(t('logging_in'));

        // Check registration status first
        const statusResponse = await fetch(`${API_BASE}/registration-status`);
        const statusData = await statusResponse.json();

        // Try to login first
        let response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });

        if (!response.ok) {
            // Registration disabled - show message
            if (!statusData.registration_enabled) {
                showError(errorEl, statusData.message || 'Get an invite from family organizer to use Family Callbook');
                hideLoading();
                return;
            }

            // Try to register (only if registration is enabled)
            showLoading(t('creating_account'));
            response = await fetch(`${API_BASE}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Login failed');
        }

        const data = await response.json();
        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('authToken', authToken);

        // Fetch full user info to get is_first_user flag
        const meResponse = await fetch(`${API_BASE}/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (meResponse.ok) {
            const meData = await meResponse.json();
            currentUser.is_first_user = meData.is_first_user || false;
        }

        // Load TURN config first (needed for calls)
        showLoading(t('loading_configuration'));
        await loadTURNConfig();

        // Initialize push notifications
        showLoading(t('initializing_notifications'));
        await initPushNotifications();

        // Connect WebSocket first so online status is set before loading contacts
        connectWebSocket();

        // Wait a bit for WebSocket to connect and register
        await new Promise(resolve => setTimeout(resolve, 500));

        // Load contacts
        showLoading(t('loading_contacts'));
        await loadContacts();

        showScreen('app-screen');
        const mobileUsernameEl = document.getElementById('mobile-current-username');
        if (mobileUsernameEl) mobileUsernameEl.textContent = currentUser.username;

        // Check and show install prompt if available
        checkAndShowPrompts();

        // Show/hide add contact button based on first user status
        const addContactBtn = document.getElementById('add-contact-btn');
        if (addContactBtn) {
            addContactBtn.style.display = currentUser.is_first_user ? 'block' : 'none';
        }

        // Show/hide backup/restore section based on first user status
        const backupRestoreSection = document.getElementById('backup-restore-section');
        if (backupRestoreSection) {
            backupRestoreSection.style.display = currentUser.is_first_user ? 'block' : 'none';
        }

        hideLoading();

    } catch (error) {
        hideLoading();
        showError(errorEl, error.message);
    }
}

// Fetch user info
async function fetchUserInfo() {
    // Ensure we have the latest token
    authToken = localStorage.getItem('authToken');

    if (!authToken) {
        showScreen('login-screen');
        return;
    }

    try {
        showLoading(t('loading_user_info'));
        const response = await fetch(`${API_BASE}/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (!response.ok) {
            if (response.status === 401) {
                // Token is invalid, clear it
                console.log('Token invalid (401), clearing auth');
                localStorage.removeItem('authToken');
                authToken = null;
                currentUser = null;
                showScreen('login-screen');
                throw new Error('Session expired');
            }
            console.error('Failed to fetch user info:', response.status, response.statusText);
            throw new Error('Failed to fetch user info');
        }

        const userData = await response.json();
        currentUser = userData;
        currentUser.is_first_user = userData.is_first_user || false;
        console.log('User authenticated:', currentUser.username, 'is_first_user:', currentUser.is_first_user);
        const mobileUsernameEl = document.getElementById('mobile-current-username');
        if (mobileUsernameEl) mobileUsernameEl.textContent = currentUser.username;

        // Show/hide add contact button based on first user status
        const addContactBtn = document.getElementById('add-contact-btn');
        if (addContactBtn) {
            addContactBtn.style.display = currentUser.is_first_user ? 'block' : 'none';
        }

        // Show/hide backup/restore section based on first user status
        const backupRestoreSection = document.getElementById('backup-restore-section');
        if (backupRestoreSection) {
            backupRestoreSection.style.display = currentUser.is_first_user ? 'block' : 'none';
        }

        // Load TURN config after login (with auth token)
        showLoading(t('loading_configuration'));
        await loadTURNConfig();

        // Connect WebSocket first so online status is set before loading contacts
        connectWebSocket();

        // Wait a bit for WebSocket to connect and register
        await new Promise(resolve => setTimeout(resolve, 500));

        showLoading(t('loading_contacts'));
        await loadContacts();
        await initPushNotifications();
        updateNotificationStatus(); // Update notification status display

        // Check and show prompts
        checkAndShowPrompts();

        // Check for pending call from notification URL
        const pendingCallStr = sessionStorage.getItem('pendingCall');
        let hasPendingCall = false;
        if (pendingCallStr) {
            try {
                const pendingCall = JSON.parse(pendingCallStr);
                sessionStorage.removeItem('pendingCall');
                hasPendingCall = true;
                console.log('Found pending call from notification');

                // Show call screen immediately (before WebSocket connects)
                // This ensures the call screen is visible right away
                handleCallFromNotification(pendingCall);

                // Also wait for WebSocket to connect to ensure call-request is received
                const waitForWS = setInterval(() => {
                    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                        clearInterval(waitForWS);
                        // Call screen is already shown, just ensure it stays visible
                        console.log('WebSocket connected, waiting for call-request');
                    }
                }, 100);

                // Timeout after 5 seconds
                setTimeout(() => {
                    clearInterval(waitForWS);
                }, 5000);
            } catch (err) {
                console.error('Error handling pending call:', err);
            }
        }

        // Only show app-screen if we're NOT handling a pending call
        // (handleCallFromNotification already showed call-screen)
        if (!hasPendingCall) {
            console.log('Showing app-screen');
            showScreen('app-screen');
        } else {
            console.log('Pending call detected, call-screen already shown by handleCallFromNotification');
        }

        hideLoading();
    } catch (error) {
        console.error('Error fetching user info:', error);

        // Only clear token and show login if it's an auth error
        // Don't clear token for network errors (might be temporary)
        if (error.message === 'Session expired' || error.message.includes('401')) {
            localStorage.removeItem('authToken');
            authToken = null;
            currentUser = null;
        }

        // Only show login screen if not on invite page and not already showing app-screen
        const path = window.location.pathname;
        const inviteMatch = path.match(/\/invite\/([a-f0-9-]+)/i);
        if (!inviteMatch && !currentUser) {
            showScreen('login-screen');
        }

        // Re-throw to let caller handle it
        throw error;
    }
}

// Load contacts
async function loadContacts() {
    // Ensure we have the latest token
    authToken = localStorage.getItem('authToken');

    if (!authToken) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/contacts`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (!response.ok) {
            if (response.status === 401) {
                // Token expired, clear it
                localStorage.removeItem('authToken');
                authToken = null;
                currentUser = null;
                showScreen('login-screen');
                return;
            }
            throw new Error('Failed to load contacts');
        }

        const contacts = await response.json();
        displayContacts(contacts);

        // Load pending invites if user is first user
        if (currentUser && currentUser.is_first_user) {
            await loadPendingInvites();
        }
    } catch (error) {
        console.error('Error loading contacts:', error);
        hideLoading();
    }
}

// Load pending invites (only for first user)
async function loadPendingInvites() {
    if (!authToken || !currentUser || !currentUser.is_first_user) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/invites/pending`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (!response.ok) {
            if (response.status === 403) {
                // Not first user, skip
                return;
            }
            console.error('Failed to load pending invites:', response.status);
            return;
        }

        const data = await response.json();
        displayPendingInvites(data.pending_invites || []);
    } catch (error) {
        console.error('Error loading pending invites:', error);
    }
}

// Display pending invites
function displayPendingInvites(pendingInvites) {
    const contactsSection = document.getElementById('contacts-section');
    if (!contactsSection) return;

    // Remove existing pending invites section if any
    const existingPending = document.getElementById('pending-invites-section');
    if (existingPending) {
        existingPending.remove();
    }

    if (pendingInvites.length === 0) {
        return;
    }

    // Create pending invites section
    const pendingSection = document.createElement('div');
    pendingSection.id = 'pending-invites-section';
    pendingSection.className = 'pending-invites-section';

    const header = document.createElement('div');
    header.className = 'section-header';
    const h3 = document.createElement('h3');
    h3.setAttribute('data-i18n', 'pending_invites');
    h3.textContent = t('pending_invites');
    header.appendChild(h3);

    const invitesList = document.createElement('div');
    invitesList.className = 'invites-list';

    pendingInvites.forEach(invite => {
        const item = document.createElement('div');
        item.className = 'invite-item';
        const inviteLink = window.location.origin + invite.invite_link;
        const contactName = escapeHtml(invite.contact_name);
        const escapedInviteLink = escapeHtml(inviteLink);
        const inviteId = escapeHtml(invite.id);

        // Escape single quotes for onclick handlers
        const escapedInviteLinkForOnclick = inviteLink.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const escapedContactName = contactName.replace(/'/g, "\\'").replace(/"/g, '&quot;');

        item.innerHTML = `
            <div class="invite-info">
                <span class="invite-name">${contactName}</span>
                <span class="invite-link-text">${escapedInviteLink}</span>
            </div>
            <div class="invite-actions">
                <button class="btn-icon" onclick="copyToClipboard('${escapedInviteLinkForOnclick}')" title="Copy Link">📋</button>
                ${navigator.share ? `<button class="btn-icon" onclick="shareInviteLink('${escapedInviteLinkForOnclick}')" title="Share">📤</button>` : ''}
                <button class="btn-icon" onclick="deleteInvite('${inviteId}', '${escapedContactName}')" title="Delete Invite">🗑️</button>
            </div>
        `;
        invitesList.appendChild(item);
    });

    pendingSection.appendChild(header);
    pendingSection.appendChild(invitesList);

    // Insert after contacts list
    const contactsList = document.getElementById('contacts-list');
    if (contactsList && contactsList.parentNode) {
        contactsList.parentNode.insertBefore(pendingSection, contactsList.nextSibling);
        // Apply translations to the header after adding to DOM
        applyTranslations();
    }
}

// Store contacts data for quick updates
let contactsData = [];

// Display contacts
function displayContacts(contacts) {
    const listEl = document.getElementById('contacts-list');
    const emptyEl = document.getElementById('no-contacts');

    listEl.innerHTML = '';

    // Store contacts data for later updates
    contactsData = contacts;

    if (contacts.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }

    emptyEl.style.display = 'none';

    contacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'contact-item';
        // contact.id = contact.contact_id = user ID (all the same now)
        const contactUserId = contact.id || contact.contact_id;
        item.setAttribute('data-contact-id', contactUserId);
        const contactName = escapeHtml(contact.contact_name);
        // Status indicators
        const isOnline = contact.is_online || false;
        const hasPush = contact.has_push || false;
        const onlineStatus = isOnline ? '<span class="status-indicator online" title="Online">🟢</span>' : '<span class="status-indicator offline" title="Offline">⚫</span>';
        const pushIcon = hasPush ? '<span class="push-indicator" title="Push notifications enabled">🔔</span>' : '';

        item.innerHTML = `
            <div class="contact-info">
                <div class="contact-name-row">
                    <span class="contact-name">${contactName}</span>
                </div>
            </div>
            <div class="contact-actions">
                ${onlineStatus}
                ${pushIcon}
                ${currentUser && currentUser.is_first_user ? `<button class="btn-icon" onclick="renameUser('${contactUserId}', '${contactName}')" title="Rename">✏️</button>` : ''}
                <button class="btn-icon" onclick="resendInvite('${contactUserId}')" title="Resend Invite Link">📤</button>
                <button class="btn-icon" onclick="initiateCall('${contactUserId}', '${contactUserId}', 'audio', '${contactName}')" title="Audio Call">📞</button>
                <button class="btn-icon" onclick="initiateCall('${contactUserId}', '${contactUserId}', 'video', '${contactName}')" title="Video Call">📹</button>
                ${currentUser && currentUser.is_first_user ? `<button class="btn-icon" onclick="deleteContact('${contactUserId}', '${contactName}')" title="Delete Contact">🗑️</button>` : ''}
            </div>
        `;
        listEl.appendChild(item);
    });

    // Rename functionality is available in mobile menu for first user
}

// Update contact online status in real-time
function updateContactOnlineStatus(contactUserId, isOnline) {
    console.log('[STATUS] Updating contact status:', contactUserId, 'isOnline:', isOnline);
    console.log('[STATUS] Looking in contactsData:', contactsData.length, 'contacts');

    // Update the stored contacts data
    // contact.id = contact.contact_id = user ID (all the same)
    const contact = contactsData.find(c => {
        const cid = c.id || c.contact_id;
        const match = cid === contactUserId;
        if (match) {
            console.log('[STATUS] Found contact:', c.contact_name, 'id:', cid, 'matches:', contactUserId);
        }
        return match;
    });

    if (contact) {
        contact.is_online = isOnline;
        console.log('[STATUS] Updated contact data for:', contact.contact_name);
    } else {
        console.warn('[STATUS] Contact not found in contactsData for user ID:', contactUserId);
        console.warn('[STATUS] Available contact IDs:', contactsData.map(c => c.id || c.contact_id));
    }

    // Update the UI
    const contactItem = document.querySelector(`.contact-item[data-contact-id="${contactUserId}"]`);
    if (contactItem) {
        console.log('[STATUS] Found contact item in DOM');
        const actionsRow = contactItem.querySelector('.contact-actions');
        
        if (actionsRow) {
            // Find and update the status indicator
            let statusIndicator = actionsRow.querySelector('.status-indicator');
            if (statusIndicator) {
                if (isOnline) {
                    statusIndicator.className = 'status-indicator online';
                    statusIndicator.textContent = '🟢';
                    statusIndicator.title = 'Online';
                } else {
                    statusIndicator.className = 'status-indicator offline';
                    statusIndicator.textContent = '⚫';
                    statusIndicator.title = 'Offline';
                }
                console.log('[STATUS] Updated status indicator in UI');
            } else {
                // Status indicator doesn't exist, add it at the beginning of actions row
                const onlineStatus = isOnline ? '<span class="status-indicator online" title="Online">🟢</span>' : '<span class="status-indicator offline" title="Offline">⚫</span>';
                actionsRow.insertAdjacentHTML('afterbegin', onlineStatus);
                console.log('[STATUS] Added status indicator to UI');
            }
        }
    } else {
        console.warn('[STATUS] Contact item not found in DOM for user ID:', contactUserId);
        console.warn('[STATUS] Available data-contact-id attributes:', Array.from(document.querySelectorAll('.contact-item')).map(el => el.getAttribute('data-contact-id')));
    }
}

// Delete contact (only first user can do this)
async function deleteContact(contactId, contactName) {
    // Check if user is first user
    if (!currentUser || !currentUser.is_first_user) {
        alert(t('only_organizer_can_delete'));
        return;
    }

    if (!confirm(`${t('delete_contact_confirm')} "${contactName}"?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/contacts/${contactId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete contact');
        }

        // Reload contacts list
        await loadContacts();
    } catch (error) {
        console.error('Error deleting contact:', error);
        alert(t('failed_to_copy') + ': ' + error.message);
    }
}

// Rename user (only first user can do this)
async function renameUser(userId, currentName) {
    const newName = prompt(`Enter new name for "${currentName}":`, currentName);

    if (!newName || newName.trim() === '' || newName.trim() === currentName) {
        return;
    }

    try {
        showLoading(t('renaming'));
        const response = await fetch(`${API_BASE}/users/rename`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: userId,
                username: newName.trim()
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to rename user');
        }

        // If renaming self, update currentUser
        if (userId === currentUser.id) {
            currentUser.username = newName.trim();
            const mobileUsernameEl = document.getElementById('mobile-current-username');
        if (mobileUsernameEl) mobileUsernameEl.textContent = currentUser.username;
        }

        // Reload contacts to show updated names
        await loadContacts();
        hideLoading();
    } catch (error) {
        hideLoading();
        console.error('Error renaming user:', error);
        alert(t('failed_to_copy') + ': ' + error.message);
    }
}

// Share invite link using Web Share API
async function shareInviteLink(inviteLink) {
    if (!navigator.share) {
        // Web Share API not supported, skip silently
        return;
    }

    try {
        await navigator.share({
            title: t('join_me'),
            text: t('join_me_text'),
            url: inviteLink
        });
    } catch (error) {
        // User cancelled or error occurred, ignore silently
        if (error.name !== 'AbortError') {
            console.log('Error sharing:', error);
        }
    }
}

// Copy to clipboard helper
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            alert(t('link_copied'));
        }).catch(err => {
            console.error('Failed to copy:', err);
            // Fallback to old method
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        alert(t('link_copied'));
    } catch (err) {
        console.error('Fallback copy failed:', err);
        alert(t('failed_to_copy'));
    }
    document.body.removeChild(textArea);
}

// Delete invite (only first user can do this)
async function deleteInvite(inviteId, contactName) {
    if (!confirm(`${t('delete_invite_confirm')} "${contactName}"?`)) {
        return;
    }

    try {
        showLoading(t('deleting_invite'));
        const response = await fetch(`${API_BASE}/invites/${inviteId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete invite');
        }

        // Reload pending invites
        await loadPendingInvites();
        hideLoading();
    } catch (error) {
        hideLoading();
        console.error('Error deleting invite:', error);
        alert(t('failed_to_copy') + ': ' + error.message);
    }
}

// Resend invite link for existing contact
async function resendInvite(contactId) {
    try {
        const response = await fetch(`${API_BASE}/contacts/${contactId}/invite`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to get invite link');
        }

        const data = await response.json();
        const inviteLink = window.location.origin + data.invite_link;

        // Show invite modal with the link
        document.getElementById('invite-link').value = inviteLink;
        document.getElementById('invite-modal').classList.add('active');

        // Try to open share sheet
        shareInviteLink(inviteLink);
    } catch (error) {
        console.error('Error resending invite:', error);
        alert(t('failed_to_resend_invite') + ': ' + error.message);
    }
}

// Handle add contact (creates invite link)
async function handleAddContact(e) {
    e.preventDefault();
    const contactName = document.getElementById('contact-name').value.trim();

    if (!contactName) {
        alert(t('contact_name_required'));
        return;
    }

    // Check if user is first user
    if (!currentUser || !currentUser.is_first_user) {
        alert(t('only_organizer_can_invite'));
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/contacts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ contact_name: contactName })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create invite');
        }

        const data = await response.json();
        document.getElementById('add-contact-modal').classList.remove('active');
        document.getElementById('contact-name').value = '';

        // Show invite link
        let fullLink = '';
        if (data.invite && data.invite.uuid) {
            fullLink = window.location.origin + '/invite/' + data.invite.uuid;
        } else if (data.invite_link) {
            fullLink = window.location.origin + data.invite_link;
        }

        if (fullLink) {
            document.getElementById('invite-link').value = fullLink;
            document.getElementById('invite-modal').classList.add('active');

            // Try to open share sheet
            shareInviteLink(fullLink);
        }

        await loadContacts();
    } catch (error) {
        alert(error.message || t('failed_to_copy'));
    }
}

// Initiate call
// contactUserId: user ID of the contact (User = Contact now, so same ID)
async function initiateCall(contactUserId, contactUserIdDup, callType, contactName) {
    try {
        console.log('[CALL] Initiating call - user ID:', contactUserId, 'type:', callType);

        // Show call screen with initial status
        showScreen('call-screen');
        updateCallContactName(contactName);
        updateCallStatus(t('sending_notification'));

        // Call backend API with user ID (User = Contact)
        const response = await fetch(`${API_BASE}/call`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                contact_id: contactUserId, // Backend expects user ID (User = Contact)
                call_type: callType
            })
        });

        if (!response.ok) {
            throw new Error('Failed to initiate call');
        }

        // Notification sent, wait for receiver to connect
        updateCallStatus(t('notification_sent_waiting'));

        // Set up currentCall to track the call state
        currentCall = {
            contactId: contactUserId,
            callType: callType,
            waitingForConnection: true
        };

        // Wait a bit, then check if receiver is online
        setTimeout(() => {
            if (currentCall && currentCall.waitingForConnection) {
                updateCallStatus(t('waiting_for_receiver'));
            }
        }, 2000);

        // Don't start WebRTC call yet - wait for call-accept or receiver to come online
        // The call will start when we receive call-accept or when receiver connects

    } catch (error) {
        console.error('[CALL] Error initiating call:', error);
        updateCallStatus(t('call_failed') + ': ' + error.message);
        setTimeout(() => {
            endCall();
        }, 3000);
    }
}

// Start WebRTC call
async function startCall(contactId, callType) {
    try {
        console.log('Starting call to:', contactId, 'type:', callType);

        // Ensure TURN config is loaded
        if (!rtcConfig || !rtcConfig.iceServers || rtcConfig.iceServers.length === 0) {
            console.log('[TURN] TURN config not loaded, loading now...');
            await loadTURNConfig();
            if (!rtcConfig || !rtcConfig.iceServers || rtcConfig.iceServers.length === 0) {
                console.error('[TURN] Failed to load TURN config, proceeding with empty config');
            }
        }

        // Set currentCall first so it's available for event handlers
        currentCall = { contactId, callType };

        // Get user media (this grants permissions needed for device enumeration)
        console.log('Requesting user media...');
        const constraints = {
            audio: true,
            video: callType === 'video'
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Now enumerate devices (after permissions are granted)
        await enumerateAudioOutputDevices();
        await setDefaultAudioOutput(callType);
        console.log('Got user media, tracks:', localStream.getTracks().length);
        const localVideo = document.getElementById('local-video');

        // Ensure video element is visible
        localVideo.style.display = 'block';
        localVideo.style.visibility = 'visible';

        localVideo.srcObject = localStream;

        // Explicitly play local video
        try {
            await localVideo.play();
            console.log('Local video playing');
        } catch (error) {
            console.error('Error playing local video:', error);
            // Try again after a short delay
            setTimeout(async () => {
                try {
                    await localVideo.play();
                    console.log('Local video playing after retry');
                } catch (retryError) {
                    console.error('Error playing local video after retry:', retryError);
                }
            }, 100);
        }

        // Log video track status
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            console.log('Video track enabled:', videoTrack.enabled);
            console.log('Video track readyState:', videoTrack.readyState);
            console.log('Video track settings:', videoTrack.getSettings());
        }

        // Create peer connection
        console.log('Creating peer connection with config:', rtcConfig);
        console.log('[TURN] ICE servers count:', rtcConfig.iceServers ? rtcConfig.iceServers.length : 0);
        peerConnection = new RTCPeerConnection(rtcConfig);

        // Add local stream tracks
        localStream.getTracks().forEach(track => {
            console.log('Adding track:', track.kind, track.id);
            peerConnection.addTrack(track, localStream);
        });

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('ICE candidate:', event.candidate.candidate);
                if (currentCall) {
                    sendWebSocketMessage({
                        type: 'ice-candidate',
                        to: currentCall.contactId,
                        data: event.candidate
                    });
                }
            } else {
                console.log('ICE gathering complete');
            }
        };

        // Handle remote stream
        peerConnection.ontrack = async (event) => {
            console.log('Received remote stream');
            const remoteVideo = document.getElementById('remote-video');
            remoteVideo.srcObject = event.streams[0];

            // Enumerate audio output devices
            await enumerateAudioOutputDevices();

            // Apply current audio output setting
            await setAudioOutput(remoteVideo, currentAudioOutputId);

            // Explicitly play on Android - autoplay may not work
            try {
                await remoteVideo.play();
                console.log('Remote video/audio playing');
            } catch (error) {
                console.error('Error playing remote stream:', error);
                // Try again after a short delay
                setTimeout(async () => {
                    try {
                        await remoteVideo.play();
                        console.log('Remote video/audio playing after retry');
                    } catch (retryError) {
                        console.error('Error playing remote stream after retry:', retryError);
                    }
                }, 100);
            }

            updateCallStatus(t('connected'));
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            console.log('Connection state:', state);
            updateCallStatus(state);

            if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                setTimeout(() => {
                    if (peerConnection && (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected')) {
                        endCall();
                    }
                }, 2000);
            }
        };

        // Handle ICE connection state
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                updateCallStatus(t('connection_failed'));
            } else if (peerConnection.iceConnectionState === 'connected') {
                updateCallStatus(t('connected'));
            }
        };

        // Create offer
        console.log('[OFFER] Creating offer...');
        const offer = await peerConnection.createOffer();
        console.log('[OFFER] Offer created:', offer.type);
        await peerConnection.setLocalDescription(offer);
        console.log('[OFFER] Local description set');

        // Send offer via WebSocket
        console.log('[OFFER] Sending offer to:', contactId);
        sendWebSocketMessage({
            type: 'offer',
            to: contactId,
            call_type: callType,
            data: offer
        });
        console.log('[OFFER] Offer sent successfully');

        updateCallStatus(t('connecting'));
        showScreen('call-screen');
        console.log('Call screen shown');

    } catch (error) {
        console.error('Error starting call:', error);
        alert('Failed to start call: ' + error.message);
    }
}

// Connect WebSocket
function connectWebSocket() {
    if (!authToken || !currentUser) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?user_id=${currentUser.id}`;

    wsConnection = new WebSocket(wsUrl);

    wsConnection.onopen = () => {
        console.log('WebSocket connected');
        // Send a message immediately to update LastActivity
        // This ensures we're marked as online right away
        sendWebSocketMessage({
            type: 'ping',
            to: '' // Empty to means no specific recipient
        });
        // Pending calls from notifications are handled via URL parameters
        // and checked in fetchUserInfo() after authentication
    };

    wsConnection.onmessage = (event) => {
        try {
            // Handle multiple JSON messages separated by newlines (from Go WritePump batching)
            const data = event.data;
            const messages = typeof data === 'string' ? data.split('\n').filter(line => line.trim()) : [data];

            messages.forEach(messageStr => {
                if (!messageStr || !messageStr.trim()) return;

                try {
                    const message = JSON.parse(messageStr.trim());
                    console.log('Received WebSocket message:', message.type, 'from:', message.from);
                    handleWebSocketMessage(message);
                } catch (parseError) {
                    console.error('Error parsing individual WebSocket message:', parseError, messageStr);
                }
            });
        } catch (error) {
            console.error('Error processing WebSocket message:', error, event.data);
        }
    };

    wsConnection.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    wsConnection.onclose = () => {
        console.log('WebSocket disconnected');
        // Reconnect after 3 seconds
        setTimeout(connectWebSocket, 3000);
    };
}

// Send WebSocket message
function sendWebSocketMessage(message) {
    if (!wsConnection) {
        console.error('WebSocket not connected, cannot send message:', message.type);
        return;
    }

    if (wsConnection.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not open, state:', wsConnection.readyState, 'message:', message.type);
        return;
    }

    const fullMessage = {
        ...message,
        from: currentUser.id
    };

    console.log('Sending WebSocket message:', fullMessage.type, 'to:', fullMessage.to);
    wsConnection.send(JSON.stringify(fullMessage));
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
    console.log('[WS] Handling message type:', message.type, 'from:', message.from);
    switch (message.type) {
        case 'call-request':
            handleIncomingCall(message);
            break;
        case 'call-accept':
            console.log('[WS] Call accepted by:', message.from);
            // Receiver accepted the call, start WebRTC connection
            if (currentCall && currentCall.contactId === message.from) {
                console.log('[WS] Receiver accepted, starting WebRTC call...');
                if (currentCall.waitingForConnection) {
                    currentCall.waitingForConnection = false;
                    updateCallStatus(t('receiver_connected'));
                    // Start the WebRTC call
                    startCall(currentCall.contactId, currentCall.callType).catch(error => {
                        console.error('[WS] Error starting call after accept:', error);
                        updateCallStatus(t('failed_to_start_call'));
                    });
                }
            }
            break;
        case 'call-reject':
            console.log('[WS] Call rejected by:', message.from);
            endCall();
            break;
        case 'call-end':
            console.log('[WS] Call ended by:', message.from);
            if (currentCall && currentCall.contactId === message.from) {
                updateCallStatus(t('call_ended'));
                setTimeout(() => {
                    endCall();
                }, 1000);
            }
            break;
        case 'user-online':
            console.log('[WS] User came online:', message.from);
            console.log('[WS] Current contacts data:', contactsData.map(c => ({ id: c.id, contact_id: c.contact_id, name: c.contact_name })));
            updateContactOnlineStatus(message.from, true);
            break;
        case 'user-offline':
            console.log('[WS] User went offline:', message.from);
            console.log('[WS] Current contacts data:', contactsData.map(c => ({ id: c.id, contact_id: c.contact_id, name: c.contact_name })));
            updateContactOnlineStatus(message.from, false);
            break;
        case 'offer':
            handleOffer(message);
            break;
        case 'answer':
            handleAnswer(message);
            break;
        case 'ice-candidate':
            handleIceCandidate(message);
            break;
        case 'ping':
            // Respond to ping to keep connection alive
            // Server pings are handled automatically by browser WebSocket
            // This is just for custom ping messages if needed
            break;
        default:
            console.log('[WS] Unknown message type:', message.type);
    }
}

// Handle incoming call
async function handleIncomingCall(message) {
    console.log('Incoming call from:', message.data.caller_username);

    // Show call screen immediately
    currentCall = {
        contactId: message.from,
        callType: message.call_type
    };
    updateCallContactName(message.data.caller_username);
    updateCallStatus(t('incoming_call'));
    showScreen('call-screen');

    // Auto-accept call
    console.log('Auto-accepting call...');

    // Send call-accept message
    sendWebSocketMessage({
        type: 'call-accept',
        to: message.from
    });

    // Wait for offer
    updateCallStatus(t('waiting_for_offer'));
}

// Handle offer
async function handleOffer(message) {
    try {
        console.log('[OFFER] Handling offer from:', message.from, 'call_type:', message.call_type);
        console.log('[OFFER] Offer data:', message.data);
        console.log('[OFFER] Current call state:', currentCall);

        // If we don't have currentCall set, this might be an incoming call
        // Set it up so we can handle the offer
        if (!currentCall) {
            console.log('[OFFER] No currentCall set, creating from offer (incoming call)');
            currentCall = {
                contactId: message.from,
                callType: message.call_type
            };
            // Show call screen if not already shown
            showScreen('call-screen');
            updateCallStatus(t('incoming_call'));
        }

        // Close existing peer connection if any
        if (peerConnection) {
            console.log('[OFFER] Closing existing peer connection');
            peerConnection.close();
            peerConnection = null;
        }

        // Get user media
        console.log('[OFFER] Requesting user media for answer...');
        const constraints = {
            audio: true,
            video: message.call_type === 'video'
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('[OFFER] Got user media for answer');
        
        // Enumerate devices after permissions are granted
        await enumerateAudioOutputDevices();
        
        // Set default audio output based on call type
        await setDefaultAudioOutput(message.call_type);
        
        const localVideo = document.getElementById('local-video');

        // Ensure video element is visible
        localVideo.style.display = 'block';
        localVideo.style.visibility = 'visible';

        localVideo.srcObject = localStream;

        // Explicitly play local video
        try {
            await localVideo.play();
            console.log('[OFFER] Local video playing');
        } catch (error) {
            console.error('[OFFER] Error playing local video:', error);
            // Try again after a short delay
            setTimeout(async () => {
                try {
                    await localVideo.play();
                    console.log('[OFFER] Local video playing after retry');
                } catch (retryError) {
                    console.error('[OFFER] Error playing local video after retry:', retryError);
                }
            }, 100);
        }

        // Log video track status
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            console.log('[OFFER] Video track enabled:', videoTrack.enabled);
            console.log('[OFFER] Video track readyState:', videoTrack.readyState);
            console.log('[OFFER] Video track settings:', videoTrack.getSettings());
        }

        // Create peer connection
        // Ensure TURN config is loaded
        if (!rtcConfig || !rtcConfig.iceServers || rtcConfig.iceServers.length === 0) {
            console.log('[TURN] TURN config not loaded, loading now...');
            await loadTURNConfig();
            if (!rtcConfig || !rtcConfig.iceServers || rtcConfig.iceServers.length === 0) {
                console.error('[TURN] Failed to load TURN config, proceeding with empty config');
            }
        }

        console.log('Creating peer connection for answer');
        console.log('[TURN] ICE servers count:', rtcConfig.iceServers ? rtcConfig.iceServers.length : 0);
        peerConnection = new RTCPeerConnection(rtcConfig);

        localStream.getTracks().forEach(track => {
            console.log('Adding track for answer:', track.kind);
            peerConnection.addTrack(track, localStream);
        });

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('ICE candidate for answer:', event.candidate.candidate);
                sendWebSocketMessage({
                    type: 'ice-candidate',
                    to: message.from,
                    data: event.candidate
                });
            } else {
                console.log('ICE gathering complete for answer');
            }
        };

        peerConnection.ontrack = async (event) => {
            console.log('Received remote stream');
            const remoteVideo = document.getElementById('remote-video');
            remoteVideo.srcObject = event.streams[0];

            // Enumerate audio output devices
            await enumerateAudioOutputDevices();

            // Apply current audio output setting
            await setAudioOutput(remoteVideo, currentAudioOutputId);

            // Explicitly play on Android - autoplay may not work
            try {
                await remoteVideo.play();
                console.log('Remote video/audio playing');
            } catch (error) {
                console.error('Error playing remote stream:', error);
                // Try again after a short delay
                setTimeout(async () => {
                    try {
                        await remoteVideo.play();
                        console.log('Remote video/audio playing after retry');
                    } catch (retryError) {
                        console.error('Error playing remote stream after retry:', retryError);
                    }
                }, 100);
            }

            updateCallStatus(t('connected'));
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            console.log('[OFFER] Connection state:', state);
            updateCallStatus(state);

            if (state === 'failed') {
                console.error('[OFFER] Connection failed');
                setTimeout(() => {
                    if (peerConnection && peerConnection.connectionState === 'failed') {
                        endCall();
                    }
                }, 2000);
            } else if (state === 'disconnected') {
                console.warn('[OFFER] Connection disconnected, waiting for reconnection...');
                // Don't end call immediately on disconnected - wait a bit for reconnection
                setTimeout(() => {
                    if (peerConnection && peerConnection.connectionState === 'disconnected') {
                        console.error('[OFFER] Still disconnected after timeout, ending call');
                        endCall();
                    }
                }, 5000);
            } else if (state === 'closed') {
                console.log('[OFFER] Connection closed');
                endCall();
            } else if (state === 'connected') {
                console.log('[OFFER] Connection established successfully');
                // Ensure remote video is playing
                const remoteVideo = document.getElementById('remote-video');
                if (remoteVideo.srcObject) {
                    remoteVideo.play().catch(err => {
                        console.error('[OFFER] Error playing remote stream on connect:', err);
                    });
                }
            }
        };

        // Handle ICE connection state
        peerConnection.oniceconnectionstatechange = () => {
            console.log('[OFFER] ICE connection state:', peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                updateCallStatus(t('connection_failed'));
            } else if (peerConnection.iceConnectionState === 'connected') {
                updateCallStatus(t('connected'));
                // Ensure remote video is playing when ICE connects
                const remoteVideo = document.getElementById('remote-video');
                if (remoteVideo.srcObject) {
                    remoteVideo.play().catch(err => {
                        console.error('[OFFER] Error playing remote stream on ICE connect:', err);
                    });
                }
            }
        };

        console.log('Setting remote description from offer...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.data));
        console.log('Remote description set');

        // Process any pending ICE candidates that arrived before the peer connection was ready
        await processPendingIceCandidates();

        console.log('[ANSWER] Creating answer...');
        const answer = await peerConnection.createAnswer();
        console.log('[ANSWER] Answer created:', answer.type);
        await peerConnection.setLocalDescription(answer);
        console.log('[ANSWER] Local description set for answer');

        console.log('[ANSWER] Sending answer to:', message.from);
        sendWebSocketMessage({
            type: 'answer',
            to: message.from,
            data: answer
        });
        console.log('[ANSWER] Answer sent successfully');

        currentCall = {
            contactId: message.from,
            callType: message.call_type
        };

        updateCallStatus(t('connecting'));
        showScreen('call-screen');
        console.log('Call screen shown for answer');
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

// Handle answer
async function handleAnswer(message) {
    console.log('[ANSWER] Handling answer from:', message.from);

    if (!peerConnection) {
        console.error('[ANSWER] No peer connection when receiving answer');
        return;
    }

    try {
        if (peerConnection.remoteDescription) {
            // Remote description already set, this might be a duplicate answer
            console.log('[ANSWER] Remote description already set, ignoring duplicate answer');
            return; // Don't process duplicate answers
        } else {
            console.log('[ANSWER] Setting remote description from answer...');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.data));
            console.log('[ANSWER] Remote description set from answer successfully');

            // Process any pending ICE candidates that arrived before the remote description was set
            await processPendingIceCandidates();

            updateCallStatus(t('connecting'));
        }
    } catch (error) {
        console.error('[ANSWER] Error setting remote description from answer:', error);
        updateCallStatus(t('connection_error') + ': ' + error.message);
    }
}

// Process pending ICE candidates that arrived before peer connection was ready
async function processPendingIceCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) {
        console.log('[ICE] Still not ready to process pending candidates');
        return;
    }

    console.log(`[ICE] Processing ${pendingIceCandidates.length} pending ICE candidates`);

    while (pendingIceCandidates.length > 0) {
        const message = pendingIceCandidates.shift();
        try {
            if (!message.data) continue;
            console.log('[ICE] Adding pending ICE candidate:', message.data.candidate);
            await peerConnection.addIceCandidate(new RTCIceCandidate(message.data));
            console.log('[ICE] Pending ICE candidate added successfully');
        } catch (err) {
            console.error('[ICE] Error adding pending ICE candidate:', err);
        }
    }
}

// Handle ICE candidate
async function handleIceCandidate(message) {
    console.log('[ICE] Received ICE candidate from:', message.from);

    if (!message.data) {
        console.warn('[ICE] No ICE candidate data in message');
        return;
    }

    // If no peer connection yet, store the candidate for later
    if (!peerConnection) {
        console.log('[ICE] No peer connection yet, storing candidate for later');
        pendingIceCandidates.push(message);
        return;
    }

    try {
        // Wait for remote description to be set before adding ICE candidates
        if (!peerConnection.remoteDescription) {
            console.log('[ICE] Waiting for remote description before adding ICE candidate...');
            // Store candidate and add it later
            pendingIceCandidates.push(message);
            return;
        }

        console.log('[ICE] Adding ICE candidate:', message.data.candidate);
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.data));
        console.log('[ICE] ICE candidate added successfully');
    } catch (error) {
        console.error('[ICE] Error adding ICE candidate:', error);
        // Don't throw - ICE candidates can fail and that's sometimes OK
    }
}

// Update call status
function updateCallStatus(status) {
    const statusEl = document.getElementById('call-status');
    if (statusEl) {
        const statusText = {
            'new': t('connecting'),
            'connecting': t('connecting'),
            'connected': t('connected'),
            'disconnected': t('disconnected'),
            'failed': t('connection_failed'),
            'closed': t('call_ended')
        };
        statusEl.textContent = statusText[status.toLowerCase()] || status;
    }
}

// Update call contact name
function updateCallContactName(contactName) {
    const nameEl = document.getElementById('call-contact-name');
    if (nameEl) {
        nameEl.textContent = contactName || '';
    }
}

// Make local video draggable
let dragHandlers = null; // Store handlers to prevent duplicates

function makeLocalVideoDraggable() {
    const localVideo = document.getElementById('local-video');
    if (!localVideo) return;

    // If handlers already exist, don't add them again
    if (dragHandlers) {
        return;
    }

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;

    function getPosition() {
        const rect = localVideo.getBoundingClientRect();
        const container = localVideo.parentElement.getBoundingClientRect();
        return {
            x: rect.left - container.left,
            y: rect.top - container.top
        };
    }

    function setPosition(x, y) {
        const container = localVideo.parentElement;
        const maxX = container.offsetWidth - localVideo.offsetWidth;
        const maxY = container.offsetHeight - localVideo.offsetHeight;

        x = Math.max(0, Math.min(x, maxX));
        y = Math.max(0, Math.min(y, maxY));

        localVideo.style.left = `${x}px`;
        localVideo.style.top = `${y}px`;
        localVideo.style.right = 'auto';
        localVideo.style.bottom = 'auto';
    }

    function handleStart(e) {
        isDragging = true;
        const pos = getPosition();
        if (e.type === 'touchstart') {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        } else {
            startX = e.clientX;
            startY = e.clientY;
        }
        offsetX = startX - pos.x;
        offsetY = startY - pos.y;
        e.preventDefault();
    }

    function handleMove(e) {
        if (!isDragging) return;
        e.preventDefault();

        let clientX, clientY;
        if (e.type === 'touchmove') {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        const container = localVideo.parentElement.getBoundingClientRect();
        const newX = clientX - container.left - offsetX;
        const newY = clientY - container.top - offsetY;

        setPosition(newX, newY);
    }

    function handleEnd() {
        isDragging = false;
    }

    // Initialize position if not set
    if (!localVideo.style.left && !localVideo.style.right) {
        const container = localVideo.parentElement;
        const rect = localVideo.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        setPosition(containerRect.width - rect.width - 20, containerRect.height - rect.height - 100);
    }

    // Store handlers to prevent duplicate listeners
    dragHandlers = {
        handleStart,
        handleMove,
        handleEnd
    };

    localVideo.addEventListener('mousedown', handleStart);
    localVideo.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchend', handleEnd);
}

// End call
function endCall() {
    // Notify the other party that the call is ending
    if (currentCall && currentCall.contactId && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        console.log('Sending call-end message to:', currentCall.contactId);
        sendWebSocketMessage({
            type: 'call-end',
            to: currentCall.contactId
        });
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    document.getElementById('remote-video').srcObject = null;
    document.getElementById('local-video').srcObject = null;

    const wasInCall = currentCall !== null;
    currentCall = null;
    currentAudioOutputId = 'default'; // Reset to default
    updateAudioOutputButton();

    if (wasInCall) {
        showScreen('app-screen');
    }
}


// Enumerate audio output devices
async function enumerateAudioOutputDevices() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            console.log('[AUDIO] Audio output device enumeration not supported');
            return;
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
        console.log('[AUDIO] Available audio output devices:', audioOutputDevices.length);
        audioOutputDevices.forEach((device, index) => {
            console.log(`[AUDIO] Device ${index}: id=${device.deviceId}, label="${device.label}"`);
        });
        
        // If no devices found or all labels are empty, try again after a short delay
        // (sometimes labels are populated after getUserMedia)
        if (audioOutputDevices.length === 0 || audioOutputDevices.every(d => !d.label)) {
            console.log('[AUDIO] No devices with labels found, retrying after delay...');
            setTimeout(async () => {
                try {
                    const retryDevices = await navigator.mediaDevices.enumerateDevices();
                    const retryAudioDevices = retryDevices.filter(device => device.kind === 'audiooutput');
                    if (retryAudioDevices.length > 0 && retryAudioDevices.some(d => d.label)) {
                        audioOutputDevices = retryAudioDevices;
                        console.log('[AUDIO] Retry successful, found devices:', audioOutputDevices);
                    }
                } catch (retryError) {
                    console.error('[AUDIO] Retry enumeration failed:', retryError);
                }
            }, 500);
        }
    } catch (error) {
        console.error('[AUDIO] Error enumerating audio output devices:', error);
    }
}

// Get earpiece device
function getEarpieceDevice() {
    return audioOutputDevices.find(device => 
        device.label.toLowerCase().includes('earpiece') || 
        device.label.toLowerCase().includes('receiver') ||
        device.label.toLowerCase().includes('phone')
    );
}

// Set default audio output based on call type
async function setDefaultAudioOutput(callType) {
    if (callType === 'audio') {
        // Audio calls: default to earpiece
        const earpieceDevice = getEarpieceDevice();
        if (earpieceDevice) {
            currentAudioOutputId = earpieceDevice.deviceId;
            console.log('Setting default audio output to earpiece for audio call');
        } else {
            currentAudioOutputId = 'default';
            console.log('Earpiece device not found, using default');
        }
    } else {
        // Video calls: default to speaker
        currentAudioOutputId = 'default';
        console.log('Setting default audio output to speaker for video call');
    }
    updateAudioOutputButton();
}

// Set audio output device
async function setAudioOutput(videoElement, deviceId) {
    if (!videoElement || typeof videoElement.setSinkId !== 'function') {
        console.log('setSinkId not supported on this browser');
        return;
    }

    try {
        await videoElement.setSinkId(deviceId);
        console.log('Audio output set to:', deviceId);
        updateAudioOutputButton();
    } catch (error) {
        console.error('Error setting audio output:', error);
        // Fallback to default if device not available
        if (deviceId !== 'default') {
            try {
                await videoElement.setSinkId('default');
                currentAudioOutputId = 'default';
                updateAudioOutputButton();
            } catch (fallbackError) {
                console.error('Error setting default audio output:', fallbackError);
            }
        }
    }
}

// Show/hide audio output menu
function toggleAudioOutputMenu() {
    const menu = document.getElementById('audio-output-menu');
    if (!menu) return;
    
    const isVisible = menu.style.display === 'block';
    if (isVisible) {
        menu.style.display = 'none';
    } else {
        populateAudioOutputMenu();
        menu.style.display = 'block';
    }
}

// Populate audio output menu with available devices
function populateAudioOutputMenu() {
    const list = document.getElementById('audio-output-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    // Add default option
    const defaultOption = document.createElement('div');
    defaultOption.className = 'audio-output-item';
    if (currentAudioOutputId === 'default') {
        defaultOption.classList.add('active');
    }
    defaultOption.innerHTML = `
        <span class="audio-output-icon">🔊</span>
        <span class="audio-output-label">${t('audio_speaker') || 'Speaker'} (Default)</span>
    `;
    defaultOption.onclick = () => selectAudioOutput('default');
    list.appendChild(defaultOption);
    
    // Add all available devices
    audioOutputDevices.forEach(device => {
        const item = document.createElement('div');
        item.className = 'audio-output-item';
        if (currentAudioOutputId === device.deviceId) {
            item.classList.add('active');
        }
        
        // Determine icon based on device label
        let icon = '🔊';
        const labelLower = device.label.toLowerCase();
        if (labelLower.includes('earpiece') || labelLower.includes('receiver') || labelLower.includes('phone')) {
            icon = '📱';
        } else if (labelLower.includes('headphone') || labelLower.includes('headset')) {
            icon = '🎧';
        }
        
        item.innerHTML = `
            <span class="audio-output-icon">${icon}</span>
            <span class="audio-output-label">${device.label || 'Unknown Device'}</span>
        `;
        item.onclick = () => selectAudioOutput(device.deviceId);
        list.appendChild(item);
    });
}

// Select audio output device
async function selectAudioOutput(deviceId) {
    const remoteVideo = document.getElementById('remote-video');
    if (!remoteVideo || !remoteVideo.srcObject) {
        console.warn('[AUDIO] Cannot select: remote video not available');
        return;
    }
    
    console.log('[AUDIO] Selecting audio output:', deviceId);
    currentAudioOutputId = deviceId;
    await setAudioOutput(remoteVideo, deviceId);
    
    // Close menu
    const menu = document.getElementById('audio-output-menu');
    if (menu) {
        menu.style.display = 'none';
    }
    
    // Update menu to show selected item
    populateAudioOutputMenu();
}

// Update audio output button icon and title
function updateAudioOutputButton() {
    const btn = document.getElementById('audio-output-btn');
    if (!btn) {
        console.warn('[AUDIO] Audio output button not found in DOM');
        return;
    }

    // Ensure button is visible
    btn.style.display = 'block';
    
    if (currentAudioOutputId === 'default') {
        btn.textContent = '🔊';
        btn.title = t('audio_speaker') || 'Speaker';
        console.log('[AUDIO] Button updated to Speaker mode');
    } else {
        // Find the selected device to show appropriate icon
        const selectedDevice = audioOutputDevices.find(d => d.deviceId === currentAudioOutputId);
        let icon = '🔊';
        let title = 'Audio Output';
        
        if (selectedDevice) {
            const labelLower = selectedDevice.label.toLowerCase();
            if (labelLower.includes('earpiece') || labelLower.includes('receiver') || labelLower.includes('phone')) {
                icon = '📱';
                title = t('audio_earpiece') || 'Earpiece';
            } else if (labelLower.includes('headphone') || labelLower.includes('headset')) {
                icon = '🎧';
                title = selectedDevice.label;
            } else {
                title = selectedDevice.label;
            }
        } else {
            icon = '📱';
            title = t('audio_earpiece') || 'Earpiece';
        }
        
        btn.textContent = icon;
        btn.title = title;
        console.log('[AUDIO] Button updated, device ID:', currentAudioOutputId);
    }
}

// Setup call controls
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('end-call-btn').addEventListener('click', endCall);

    document.getElementById('mute-btn').addEventListener('click', () => {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
            }
        }
    });

    document.getElementById('video-toggle-btn').addEventListener('click', () => {
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
            }
        }
    });

    // Audio output device menu
    const audioOutputBtn = document.getElementById('audio-output-btn');
    if (audioOutputBtn) {
        audioOutputBtn.addEventListener('click', toggleAudioOutputMenu);
        updateAudioOutputButton(); // Initialize button state
        console.log('[AUDIO] Audio output button initialized');
        
        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('audio-output-menu');
            const container = document.querySelector('.audio-output-container');
            if (menu && container && !container.contains(e.target)) {
                menu.style.display = 'none';
            }
        });
    } else {
        console.error('[AUDIO] Audio output button not found in DOM!');
    }

    // Make local video draggable when call screen is shown
    const originalShowScreen = window.showScreen || showScreen;
    window.showScreen = function (screenId) {
        originalShowScreen(screenId);
        if (screenId === 'call-screen') {
            // Small delay to ensure video element is ready
            setTimeout(() => {
                makeLocalVideoDraggable();
            }, 100);
        }
    };
});

// Push Notifications
async function initPushNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        updateNotificationStatus(); // Update status display
        return;
    }

    // Check current permission status
    const permission = Notification.permission;

    if (permission === 'default') {
        // Permission not requested yet - show prompt
        showNotificationPrompt();
        updateNotificationStatus(); // Update status display
        return;
    }

    if (permission === 'denied') {
        // Permission denied - show prompt if not dismissed
        if (!localStorage.getItem('notification-prompt-dismissed')) {
            showNotificationPrompt();
        }
        updateNotificationStatus(); // Update status display
        return;
    }

    // Permission granted, proceed with subscription
    await subscribeToPush();
}

// Show notification permission prompt
function showNotificationPrompt() {
    const prompt = document.getElementById('notification-prompt');
    if (prompt && !localStorage.getItem('notification-prompt-dismissed')) {
        prompt.style.display = 'block';
    }
}

// Request notification permission (called from button)
async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        alert(t('notifications_not_supported'));
        return;
    }

    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
        document.getElementById('notification-prompt').style.display = 'none';
        await subscribeToPush();
        updateNotificationStatus(); // Update status display
    } else {
        alert(t('enable_notifications'));
        updateNotificationStatus(); // Update status display
    }
}

// Subscribe to push notifications
async function subscribeToPush() {
    if (!authToken) {
        return;
    }

    try {
        // Get VAPID public key
        const response = await fetch(`${API_BASE}/vapid-public-key`);
        if (!response.ok) {
            console.error('Failed to get VAPID public key');
            return;
        }

        const { publicKey } = await response.json();

        if (!publicKey) {
            console.error('VAPID public key is empty');
            return;
        }

        console.log('VAPID public key received:', publicKey.substring(0, 20) + '...');

        // Convert to Uint8Array
        let applicationServerKey;
        try {
            applicationServerKey = urlBase64ToUint8Array(publicKey);
            console.log('Converted key length:', applicationServerKey.length);

            // VAPID public key should be 65 bytes (uncompressed) or 87 base64 chars
            if (applicationServerKey.length !== 65) {
                console.warn('VAPID key length is', applicationServerKey.length, 'expected 65');
            }
        } catch (error) {
            console.error('Error converting VAPID key:', error);
            return;
        }

        // Subscribe to push
        const registration = await navigator.serviceWorker.ready;

        // Always refresh subscription on page load to keep it current
        // Unsubscribe from existing subscription first to ensure we get a fresh one
        try {
            const existingSubscription = await registration.pushManager.getSubscription();
            if (existingSubscription) {
                console.log('Refreshing push subscription on page load...');
                await existingSubscription.unsubscribe();
            }
        } catch (error) {
            console.warn('Error checking/unsubscribing from existing subscription:', error);
        }

        // Always create a new subscription to ensure it's current
        let subscription;
        try {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });
            console.log('Successfully subscribed/refreshed push notifications');
        } catch (error) {
            console.error('Error subscribing to push:', error);
            console.error('Public key used:', publicKey);
            console.error('Key length:', publicKey.length);
            alert(t('failed_to_enable_push') + ': ' + error.message);
            return;
        }

        // Send subscription to server
        try {
            // Extract keys from subscription - getKey() returns ArrayBuffer
            let p256dhKey, authKey;

            if (subscription.getKey) {
                p256dhKey = subscription.getKey('p256dh');
                authKey = subscription.getKey('auth');
            } else if (subscription.keys) {
                p256dhKey = subscription.keys.p256dh;
                authKey = subscription.keys.auth;
            } else {
                console.error('Subscription object does not have getKey() or keys property');
                console.error('Subscription:', JSON.stringify(subscription, null, 2));
                return;
            }

            if (!p256dhKey || !authKey) {
                console.error('Failed to extract push subscription keys');
                console.error('p256dh:', p256dhKey);
                console.error('auth:', authKey);
                return;
            }

            // Convert ArrayBuffer to Uint8Array
            let p256dhArray, authArray;

            if (p256dhKey instanceof ArrayBuffer) {
                p256dhArray = new Uint8Array(p256dhKey);
            } else if (p256dhKey instanceof Uint8Array) {
                p256dhArray = p256dhKey;
            } else {
                console.error('Invalid p256dh key type:', typeof p256dhKey, p256dhKey);
                return;
            }

            if (authKey instanceof ArrayBuffer) {
                authArray = new Uint8Array(authKey);
            } else if (authKey instanceof Uint8Array) {
                authArray = authKey;
            } else {
                console.error('Invalid auth key type:', typeof authKey, authKey);
                return;
            }

            console.log('Extracted keys - p256dh length:', p256dhArray.length, 'auth length:', authArray.length);

            // Ensure we have valid Uint8Arrays
            if (!(p256dhArray instanceof Uint8Array) || !(authArray instanceof Uint8Array)) {
                console.error('Failed to convert keys to Uint8Array');
                return;
            }

            // Always send subscription to server to keep it updated
            // The server will delete old subscriptions and create/update this one
            const subscribeResponse = await fetch(`${API_BASE}/push/subscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    endpoint: subscription.endpoint,
                    keys: {
                        p256dh: uint8ArrayToBase64(p256dhArray),
                        auth: uint8ArrayToBase64(authArray)
                    }
                })
            });

            if (!subscribeResponse.ok) {
                const errorText = await subscribeResponse.text();
                console.error('Failed to save subscription to server:', errorText);
                throw new Error('Failed to save subscription to server: ' + errorText);
            }

            console.log('Push subscription successfully updated on server');
            updateNotificationStatus(); // Update status display after successful subscription
        } catch (error) {
            console.error('Error saving subscription to server:', error);
            updateNotificationStatus(); // Update status display even on error
        }
    } catch (error) {
        console.error('Error in subscribeToPush:', error);
        updateNotificationStatus(); // Update status display even on error
    }
}

// Check and update notification status display
async function updateNotificationStatus() {
    const mobileStatusEl = document.getElementById('mobile-notification-status');
    
    // Check if notifications are supported
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        if (mobileStatusEl) mobileStatusEl.style.display = 'none';
        return;
    }

    const permission = Notification.permission;
    let isSubscribed = false;

    // Check if we have an active push subscription
    if (permission === 'granted') {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            isSubscribed = subscription !== null;
        } catch (error) {
            console.error('Error checking push subscription:', error);
        }
    }

    if (!mobileStatusEl) return;
    
    // Show status element
    mobileStatusEl.style.display = 'inline-block';

    if (permission === 'granted' && isSubscribed) {
        // Notifications enabled
        mobileStatusEl.textContent = '🔔 ' + t('notifications_enabled');
        mobileStatusEl.className = 'notification-status enabled';
        mobileStatusEl.title = t('notifications_enabled');
        mobileStatusEl.onclick = null;
        mobileStatusEl.style.cursor = 'default';
    } else {
        // Notifications disabled or not subscribed
        mobileStatusEl.textContent = '🔕 ' + t('notifications_disabled');
        mobileStatusEl.className = 'notification-status disabled';
        mobileStatusEl.title = t('notifications_disabled');
        mobileStatusEl.onclick = async () => {
            await requestNotificationPermission();
        };
        mobileStatusEl.style.cursor = 'pointer';
    }
}

// Mobile menu functions
function openMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    const overlay = document.getElementById('mobile-menu-overlay');
    if (menu) menu.classList.add('active');
    if (overlay) overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    const overlay = document.getElementById('mobile-menu-overlay');
    if (menu) menu.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
    document.body.style.overflow = '';
}

// Backup handler
async function handleBackup() {
    if (!authToken) {
        alert(t('backup_restore_only_organizer'));
        return;
    }

    try {
        showLoading(t('backup'));
        const response = await fetch(`${API_BASE}/backup`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || t('backup_failed'));
        }

        // Get filename from Content-Disposition header or use default
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'familycall-backup.zip';
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
            if (filenameMatch) {
                filename = filenameMatch[1];
            }
        }

        // Download the file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        hideLoading();
        alert(t('backup_created'));
        closeMobileMenu();
    } catch (error) {
        hideLoading();
        alert(t('backup_failed') + ': ' + error.message);
    }
}

// Restore handler
async function handleRestore(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    if (!authToken) {
        alert(t('backup_restore_only_organizer'));
        return;
    }

    // Confirm restore action
    if (!confirm(t('select_backup_file') + '\n\n' + 'This will replace your current keys, certificates, and database. Continue?')) {
        event.target.value = ''; // Reset file input
        return;
    }

    try {
        showLoading(t('restore'));
        const formData = new FormData();
        formData.append('backup', file);

        const response = await fetch(`${API_BASE}/restore`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            },
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || t('restore_failed'));
        }

        const result = await response.json();
        hideLoading();
        alert(result.message || t('restore_success'));
        closeMobileMenu();
        
        // Reset file input
        event.target.value = '';
    } catch (error) {
        hideLoading();
        alert(t('restore_failed') + ': ' + error.message);
        event.target.value = ''; // Reset file input
    }
}

// Handle call from notification URL parameters
function handleCallFromNotification(callData) {
    console.log('Handling call from notification:', callData);

    if (!callData.caller_id || !callData.caller_name || !callData.call_type) {
        console.error('Invalid call data from notification');
        return;
    }

    // Show call screen immediately - waiting for call-request via WebSocket
    // The server will resend call-request when user comes online
    showScreen('call-screen');
    updateCallContactName(callData.caller_name);
    updateCallStatus(t('connecting'));

    // Store expected caller ID to match when call-request arrives
    const expectedCallerId = callData.caller_id;

    // Wait for call-request to arrive (handleIncomingCall will be called automatically)
    const checkInterval = setInterval(() => {
        if (currentCall && currentCall.contactId === expectedCallerId) {
            // Call started - handleIncomingCall was called and set up currentCall
            console.log('Call started from notification');
            clearInterval(checkInterval);
        }
    }, 500);

    // Timeout after 10 seconds if call-request doesn't arrive
    setTimeout(() => {
        clearInterval(checkInterval);
        if (!currentCall || currentCall.contactId !== expectedCallerId) {
            console.log('Call-request timeout - caller may have disconnected');
            updateCallStatus(t('call_may_have_ended'));
            setTimeout(() => {
                if (!currentCall || currentCall.contactId !== expectedCallerId) {
                    endCall();
                }
            }, 3000);
        }
    }, 10000);
}

// Utility functions
function showScreen(screenId) {
    // Don't hide call-screen if there's an active call (unless explicitly showing call-screen)
    if (screenId === 'app-screen' && currentCall) {
        console.log('Preventing app-screen from hiding active call');
        return;
    }

    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
    
    // Show install banner if app screen is shown
    if (screenId === 'app-screen') {
        showInstallBannerIfNeeded();
    }
    console.log('Screen shown:', screenId);

    // Make local video draggable when call screen is shown
    if (screenId === 'call-screen') {
        setTimeout(() => {
            makeLocalVideoDraggable();
        }, 100);
    }
}

function showError(element, message) {
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => {
        element.classList.remove('show');
    }, 5000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function urlBase64ToUint8Array(base64String) {
    if (!base64String || typeof base64String !== 'string') {
        throw new Error('VAPID key must be a non-empty string');
    }

    // Remove any whitespace and newlines
    base64String = base64String.trim().replace(/\s/g, '');

    if (base64String.length === 0) {
        throw new Error('VAPID key is empty after trimming');
    }

    // Add padding if needed (base64 URL-safe format uses = for padding)
    let padding = '';
    const remainder = base64String.length % 4;
    if (remainder !== 0) {
        padding = '='.repeat(4 - remainder);
    }

    // Convert URL-safe base64 to standard base64
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    try {
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);

        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }

        // VAPID public key should be 65 bytes (uncompressed EC public key)
        // But some implementations might return different lengths, so we'll be flexible
        if (outputArray.length < 64 || outputArray.length > 66) {
            console.warn('VAPID key length is', outputArray.length, 'bytes (expected ~65)');
        }

        return outputArray;
    } catch (e) {
        console.error('Error converting VAPID key:', e);
        console.error('Key string:', base64String.substring(0, 50) + '...');
        console.error('Key length:', base64String.length);
        throw new Error('Invalid VAPID public key format: ' + e.message);
    }
}

function uint8ArrayToBase64(uint8Array) {
    // Ensure we have a Uint8Array
    if (!(uint8Array instanceof Uint8Array)) {
        console.error('uint8ArrayToBase64: Expected Uint8Array, got:', typeof uint8Array, uint8Array);
        // Try to convert if it's an ArrayBuffer
        if (uint8Array instanceof ArrayBuffer) {
            uint8Array = new Uint8Array(uint8Array);
        } else {
            throw new Error('Invalid input type for uint8ArrayToBase64');
        }
    }

    let binary = '';
    // Use for loop instead of forEach for compatibility
    for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
    }

    // Convert to base64 URL-safe (webpush requires URL-safe base64)
    const base64 = window.btoa(binary);
    // Convert standard base64 to URL-safe base64
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function handleLogout() {
    localStorage.removeItem('authToken');
    authToken = null;
    currentUser = null;
    if (wsConnection) {
        wsConnection.close();
        wsConnection = null;
    }
    // Stop contacts refresh interval
    if (contactsRefreshInterval) {
        clearInterval(contactsRefreshInterval);
        contactsRefreshInterval = null;
    }
    showScreen('login-screen');
}

// Install prompt
let deferredPrompt;

function checkInstallPrompt() {
    if (window.matchMedia('(display-mode: standalone)').matches) {
        document.getElementById('install-prompt').style.display = 'none';
        document.getElementById('install-app-prompt').style.display = 'none';
    }
}

// Show install banner if app screen is active and app is not installed
function showInstallBannerIfNeeded() {
    const isInstalled = window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone ||
        document.referrer.includes('android-app://');
    
    const appScreen = document.getElementById('app-screen');
    const isAppScreenActive = appScreen && appScreen.classList.contains('active');
    
    if (!isInstalled && !localStorage.getItem('install-prompt-dismissed') && isAppScreenActive) {
        // Hide login screen prompt if visible
        const loginPrompt = document.getElementById('install-prompt');
        if (loginPrompt) loginPrompt.style.display = 'none';
        // Show app screen prompt above contacts
        const installBanner = document.getElementById('install-app-prompt');
        if (installBanner) {
            installBanner.style.display = 'block';
        }
    } else if (isInstalled || localStorage.getItem('install-prompt-dismissed')) {
        // Hide banner if installed or dismissed
        const installBanner = document.getElementById('install-app-prompt');
        if (installBanner) {
            installBanner.style.display = 'none';
        }
    }
}

// Check and show prompts for notifications and app installation
function checkAndShowPrompts() {
    // Check notification permission
    if ('Notification' in window) {
        const permission = Notification.permission;
        if (permission === 'default' || permission === 'denied') {
            if (!localStorage.getItem('notification-prompt-dismissed')) {
                showNotificationPrompt();
            }
        }
    }

    // Check if app is installed
    const isInstalled = window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone ||
        document.referrer.includes('android-app://');

    // Show install banner (handled by showInstallBannerIfNeeded)
    showInstallBannerIfNeeded();
}

// Check PWA installability criteria
async function checkPWAInstallability() {
    console.log('Checking PWA installability...');

    // Check HTTPS
    const isHTTPS = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    console.log('HTTPS:', isHTTPS);

    // Check manifest
    try {
        const manifestResponse = await fetch('/manifest.json');
        if (manifestResponse.ok) {
            const manifest = await manifestResponse.json();
            console.log('Manifest loaded:', manifest);
            console.log('Manifest name:', manifest.name);
            console.log('Manifest icons:', manifest.icons?.length || 0);
        } else {
            console.error('Manifest not found or invalid');
        }
    } catch (error) {
        console.error('Error loading manifest:', error);
    }

    // Check service worker
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration) {
                console.log('Service Worker registered:', registration.scope);
            } else {
                console.warn('Service Worker not registered');
            }
        } catch (error) {
            console.error('Error checking service worker:', error);
        }
    }

    // Check if running in standalone mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    console.log('Standalone mode:', isStandalone);

    console.log('Note: Chrome requires user engagement (user interaction) before showing install prompt');
    console.log('The install icon appears in the address bar after visiting the site');
}

// Enhanced install prompt handler
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    console.log('beforeinstallprompt event fired, deferredPrompt set');

    // Show banner if app screen is active
    showInstallBannerIfNeeded();
});

// Enhanced install function
function installApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('User accepted the install prompt');
            }
            deferredPrompt = null;
            document.getElementById('install-prompt').style.display = 'none';
            document.getElementById('install-app-prompt').style.display = 'none';
        });
    } else {
        // Fallback: show instructions
        alert(t('install_app_instructions'));
    }
}

// Check if we're on an invite page and handle it
async function checkInvitePage() {
    const path = window.location.pathname;
    const inviteMatch = path.match(/\/invite\/([a-f0-9-]+)/i);

    if (inviteMatch) {
        const uuid = inviteMatch[1];

        try {
            // Fetch invite details
            const response = await fetch(`${API_BASE}/invite/${uuid}`);
            if (!response.ok) {
                throw new Error('Invite not found');
            }

            const invite = await response.json();

            // If invite was already accepted, auto-login as the contact
            if (invite.accepted) {
                const inviteUsername = invite.contact_name;

                // Try to login with the contact name
                try {
                    let loginResponse = await fetch(`${API_BASE}/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: inviteUsername })
                    });

                    if (!loginResponse.ok) {
                        // Try register with invite UUID if login fails (allows registration even if disabled)
                        loginResponse = await fetch(`${API_BASE}/register`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                username: inviteUsername,
                                invite_uuid: uuid
                            })
                        });
                    }

                    if (loginResponse.ok) {
                        const data = await loginResponse.json();
                        authToken = data.token;
                        currentUser = data.user;
                        localStorage.setItem('authToken', authToken);

                        // Fetch full user info to get is_first_user flag
                        const meResponse = await fetch(`${API_BASE}/me`, {
                            headers: { 'Authorization': `Bearer ${authToken}` }
                        });
                        if (meResponse.ok) {
                            const meData = await meResponse.json();
                            currentUser.is_first_user = meData.is_first_user || false;
                        }

                        // Initialize app
                        await initPushNotifications();
                        connectWebSocket();
                        await loadContacts();

                        // Redirect to main app
                        window.history.pushState({}, '', '/');
                        showScreen('app-screen');
                        const mobileUsernameEl = document.getElementById('mobile-current-username');
        if (mobileUsernameEl) mobileUsernameEl.textContent = currentUser.username;
                        return;
                    }
                } catch (error) {
                    console.error('Error auto-logging in:', error);
                }
            }

            // Show invite message
            const inviteText = document.getElementById('invite-text');
            inviteText.textContent = `${invite.from_user.username} invited you "${invite.contact_name}" to use this calling app`;

            // Store invite info
            sessionStorage.setItem('pendingInvite', uuid);
            sessionStorage.setItem('inviteUsername', invite.contact_name);
            sessionStorage.setItem('inviterName', invite.from_user.username);

            // Show invite screen
            showScreen('invite-screen');
        } catch (error) {
            console.error('Error loading invite:', error);
            alert(t('invalid_invite_link'));
            showScreen('login-screen');
        }
    }
}

// Handle invite acceptance
async function acceptInvite() {
    const pendingInvite = sessionStorage.getItem('pendingInvite');
    const inviteUsername = sessionStorage.getItem('inviteUsername');

    if (!pendingInvite) {
        alert(t('no_pending_invite'));
        return;
    }

    const errorEl = document.getElementById('invite-error');

    try {
        showLoading(t('accepting_invite'));
        // If not logged in, auto-register/login with the username from invite
        if (!authToken || !currentUser) {
            if (!inviteUsername) {
                throw new Error('Invite username not found');
            }

            showLoading(t('logging_in'));
            // Try to login first, if fails, register with invite UUID
            let response = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: inviteUsername })
            });

            if (!response.ok) {
                // Try to register with invite UUID (this allows registration even if disabled)
                showLoading(t('creating_account'));
                response = await fetch(`${API_BASE}/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: inviteUsername,
                        invite_uuid: pendingInvite
                    })
                });
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to register/login');
            }

            const data = await response.json();
            authToken = data.token;
            currentUser = data.user;
            localStorage.setItem('authToken', authToken);

            // Fetch full user info to get is_first_user flag
            const meResponse = await fetch(`${API_BASE}/me`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (meResponse.ok) {
                const meData = await meResponse.json();
                currentUser.is_first_user = meData.is_first_user || false;
            }
        }

        // Accept the invite - this updates the user's username to the contact name
        showLoading(t('accepting_invite'));
        const acceptResponse = await fetch(`${API_BASE}/invite/${pendingInvite}/accept`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`
            }
        });

        if (!acceptResponse.ok) {
            const error = await acceptResponse.json();
            throw new Error(error.error || 'Failed to accept invite');
        }

        const acceptData = await acceptResponse.json();
        console.log('Invite accepted:', acceptData);

        // Update current user with new username (accepting invite updates username)
        if (acceptData.user) {
            currentUser = acceptData.user;
            localStorage.setItem('authToken', authToken); // Keep same token
        }

        // Initialize push notifications and WebSocket
        showLoading(t('initializing'));
        await initPushNotifications();
        connectWebSocket();
        showLoading(t('loading_contacts'));
        await loadContacts();

        // Clear invite info
        sessionStorage.removeItem('pendingInvite');
        sessionStorage.removeItem('inviteUsername');
        sessionStorage.removeItem('inviterName');

        // Redirect to main app
        window.history.pushState({}, '', '/');
        showScreen('app-screen');
        const mobileUsernameEl = document.getElementById('mobile-current-username');
        if (mobileUsernameEl) mobileUsernameEl.textContent = currentUser.username;

        // Show/hide add contact button based on first user status
        const addContactBtn = document.getElementById('add-contact-btn');
        if (addContactBtn) {
            addContactBtn.style.display = currentUser.is_first_user ? 'block' : 'none';
        }

        // Show/hide backup/restore section based on first user status
        const backupRestoreSection = document.getElementById('backup-restore-section');
        if (backupRestoreSection) {
            backupRestoreSection.style.display = currentUser.is_first_user ? 'block' : 'none';
        }

        hideLoading();

    } catch (error) {
        hideLoading();
        showError(errorEl, error.message);
    }
}

