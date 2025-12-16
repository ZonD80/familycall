// API Configuration
// Use injected API_BASE if available (for backend-only mode), otherwise use relative path
const API_BASE = (typeof window !== 'undefined' && window.API_BASE) || '/api';
let authToken = localStorage.getItem('authToken');
let currentUser = null;
let wsConnection = null;
let peerConnection = null;
let localStream = null;
let currentCall = null;

// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    checkAuth();
    setupEventListeners();
    checkInstallPrompt();
});

// Service Worker Registration
async function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('/service-worker.js');
            console.log('Service Worker registered:', registration);
        } catch (error) {
            console.error('Service Worker registration failed:', error);
        }
    }
}

// Check authentication
function checkAuth() {
    if (authToken) {
        fetchUserInfo();
    } else {
        showScreen('login-screen');
    }
}

// Setup event listeners
function setupEventListeners() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    
    // Logout
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    
    // Add contact
    document.getElementById('add-contact-btn').addEventListener('click', () => {
        document.getElementById('add-contact-modal').classList.add('active');
    });
    
    document.getElementById('add-contact-form').addEventListener('submit', handleAddContact);
    document.getElementById('cancel-contact-btn').addEventListener('click', () => {
        document.getElementById('add-contact-modal').classList.remove('active');
    });
    
    // Install prompt
    const installBtn = document.getElementById('install-btn');
    if (installBtn) {
        installBtn.addEventListener('click', installApp);
    }
    
    // Listen for service worker messages
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
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
        // Try to login first, if fails, register
        let response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        
        if (!response.ok) {
            // Try to register
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
        
        // Initialize push notifications
        await initPushNotifications();
        
        // Connect WebSocket
        connectWebSocket();
        
        // Load contacts
        loadContacts();
        
        showScreen('app-screen');
        document.getElementById('current-username').textContent = currentUser.username;
        
    } catch (error) {
        showError(errorEl, error.message);
    }
}

// Fetch user info
async function fetchUserInfo() {
    try {
        const response = await fetch(`${API_BASE}/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch user info');
        }
        
        currentUser = await response.json();
        document.getElementById('current-username').textContent = currentUser.username;
        loadContacts();
        connectWebSocket();
        await initPushNotifications();
        showScreen('app-screen');
    } catch (error) {
        localStorage.removeItem('authToken');
        authToken = null;
        showScreen('login-screen');
    }
}

// Load contacts
async function loadContacts() {
    try {
        const response = await fetch(`${API_BASE}/contacts`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        if (!response.ok) throw new Error('Failed to load contacts');
        
        const contacts = await response.json();
        displayContacts(contacts);
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

// Display contacts
function displayContacts(contacts) {
    const listEl = document.getElementById('contacts-list');
    const emptyEl = document.getElementById('no-contacts');
    
    listEl.innerHTML = '';
    
    if (contacts.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    
    emptyEl.style.display = 'none';
    
    contacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'contact-item';
        item.innerHTML = `
            <div class="contact-info">
                <div class="contact-name">${escapeHtml(contact.contact_name)}</div>
            </div>
            <div class="contact-actions">
                <button class="btn-icon" onclick="initiateCall('${contact.id}', 'audio')" title="Audio Call">📞</button>
                <button class="btn-icon" onclick="initiateCall('${contact.id}', 'video')" title="Video Call">📹</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

// Handle add contact
async function handleAddContact(e) {
    e.preventDefault();
    const contactName = document.getElementById('contact-name').value.trim();
    
    if (!contactName) return;
    
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
            throw new Error(error.error || 'Failed to add contact');
        }
        
        document.getElementById('add-contact-modal').classList.remove('active');
        document.getElementById('contact-name').value = '';
        loadContacts();
    } catch (error) {
        alert(error.message);
    }
}

// Initiate call
async function initiateCall(contactId, callType) {
    try {
        const response = await fetch(`${API_BASE}/call`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                contact_id: contactId,
                call_type: callType
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to initiate call');
        }
        
        // Start WebRTC call
        await startCall(contactId, callType);
    } catch (error) {
        alert('Failed to start call: ' + error.message);
    }
}

// Start WebRTC call
async function startCall(contactId, callType) {
    try {
        // Get user media
        const constraints = {
            audio: true,
            video: callType === 'video'
        };
        
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        document.getElementById('local-video').srcObject = localStream;
        
        // Create peer connection
        peerConnection = new RTCPeerConnection(rtcConfig);
        
        // Add local stream tracks
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendWebSocketMessage({
                    type: 'ice-candidate',
                    to: currentCall.contactId,
                    data: event.candidate
                });
            }
        };
        
        // Handle remote stream
        peerConnection.ontrack = (event) => {
            document.getElementById('remote-video').srcObject = event.streams[0];
        };
        
        // Create offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        // Send offer via WebSocket
        sendWebSocketMessage({
            type: 'offer',
            to: currentCall.contactId,
            call_type: callType,
            data: offer
        });
        
        currentCall = { contactId, callType };
        showScreen('call-screen');
        
    } catch (error) {
        console.error('Error starting call:', error);
        alert('Failed to start call: ' + error.message);
    }
}

// Connect WebSocket
function connectWebSocket() {
    if (!authToken || !currentUser) return;
    
    // Use frontend URI for WebSocket if in backend-only mode
    let wsHost;
    if (typeof window !== 'undefined' && window.API_BASE) {
        // Extract host from API_BASE (e.g., 'https://domain.host/api' -> 'domain.host')
        const apiBaseUrl = new URL(window.API_BASE.replace('/api', ''));
        const protocol = apiBaseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsHost = `${protocol}//${apiBaseUrl.host}`;
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsHost = `${protocol}//${window.location.host}`;
    }
    const wsUrl = `${wsHost}/ws?user_id=${currentUser.id}`;
    
    wsConnection = new WebSocket(wsUrl);
    
    wsConnection.onopen = () => {
        console.log('WebSocket connected');
    };
    
    wsConnection.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
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
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({
            ...message,
            from: currentUser.id
        }));
    }
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'call-request':
            handleIncomingCall(message);
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
    }
}

// Handle incoming call
async function handleIncomingCall(message) {
    const accept = confirm(`${message.data.caller_username} is calling you. Accept?`);
    
    if (accept) {
        currentCall = {
            contactId: message.from,
            callType: message.call_type
        };
        
        await startCall(message.from, message.call_type);
    } else {
        sendWebSocketMessage({
            type: 'call-reject',
            to: message.from
        });
    }
}

// Handle offer
async function handleOffer(message) {
    try {
        // Get user media
        const constraints = {
            audio: true,
            video: message.call_type === 'video'
        };
        
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        document.getElementById('local-video').srcObject = localStream;
        
        // Create peer connection
        peerConnection = new RTCPeerConnection(rtcConfig);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendWebSocketMessage({
                    type: 'ice-candidate',
                    to: message.from,
                    data: event.candidate
                });
            }
        };
        
        peerConnection.ontrack = (event) => {
            document.getElementById('remote-video').srcObject = event.streams[0];
        };
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.data));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        sendWebSocketMessage({
            type: 'answer',
            to: message.from,
            data: answer
        });
        
        currentCall = {
            contactId: message.from,
            callType: message.call_type
        };
        
        showScreen('call-screen');
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

// Handle answer
async function handleAnswer(message) {
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.data));
    }
}

// Handle ICE candidate
async function handleIceCandidate(message) {
    if (peerConnection && message.data) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.data));
    }
}

// End call
function endCall() {
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
    
    currentCall = null;
    showScreen('app-screen');
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
});

// Push Notifications
async function initPushNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
        return;
    }
    
    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        return;
    }
    
    // Get VAPID public key
    const response = await fetch(`${API_BASE}/vapid-public-key`);
    const { publicKey } = await response.json();
    
    // Subscribe to push
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    
    // Send subscription to server
    await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
            endpoint: subscription.endpoint,
            keys: {
                p256dh: uint8ArrayToBase64(subscription.getKey('p256dh')),
                auth: uint8ArrayToBase64(subscription.getKey('auth'))
            }
        })
    });
}

// Handle service worker messages
function handleServiceWorkerMessage(event) {
    if (event.data && event.data.type === 'call-notification-clicked') {
        // Handle call from notification
        const callData = event.data.data;
        if (callData && callData.type === 'call') {
            // Auto-answer or show call screen
            console.log('Call notification clicked:', callData);
        }
    }
}

// Utility functions
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
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
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');
    
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function uint8ArrayToBase64(uint8Array) {
    let binary = '';
    uint8Array.forEach(byte => {
        binary += String.fromCharCode(byte);
    });
    return window.btoa(binary);
}

function handleLogout() {
    localStorage.removeItem('authToken');
    authToken = null;
    currentUser = null;
    if (wsConnection) {
        wsConnection.close();
    }
    showScreen('login-screen');
}

// Install prompt
let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('install-prompt').style.display = 'block';
});

function installApp() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('User accepted the install prompt');
            }
            deferredPrompt = null;
            document.getElementById('install-prompt').style.display = 'none';
        });
    }
}

function checkInstallPrompt() {
    if (window.matchMedia('(display-mode: standalone)').matches) {
        document.getElementById('install-prompt').style.display = 'none';
    }
}

