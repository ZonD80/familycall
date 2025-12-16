# Family Callbook

A self-hosted family communication app with video and audio calling capabilities. Family Callbook enables secure, private video and audio calls between family members using WebRTC technology, with built-in TURN/STUN server support for reliable connectivity even behind NATs.

## Features

### Core Functionality

- **Video & Audio Calling**: High-quality WebRTC-based video and audio calls between family members
- **Built-in TURN/STUN Server**: Reliable connectivity even when users are behind NATs or firewalls
- **Progressive Web App (PWA)**: Installable on mobile devices (Android/iOS) and desktop browsers
- **Push Notifications**: Receive call notifications even when the app is closed
- **Multi-language Support**: Currently supports English and Russian (with easy extensibility)
- **Contact Management**: Simple contact list with online status indicators
- **Invite-Based Registration**: Secure family-only access through invite links
- **Backup & Restore**: Family organizer can backup and restore keys, certificates, and database

### Technical Features

- **Low Bandwidth Usage**: Optimized for ~500 kbps bidirectional bandwidth per call
- **End-to-End Encryption**: WebRTC DTLS-SRTP encryption for media streams
- **Automatic SSL/TLS**: Let's Encrypt certificate management with automatic renewal
- **Self-Hosted**: Complete control over your data and communication
- **Single Binary**: Easy deployment with embedded web assets

## How Family Communication Works

### First User Registration (Family Organizer)

1. **Initial Setup**: The first user to register becomes the "family organizer" who manages the family network
2. **Registration**: Visit the app URL, enter a username, and complete registration
3. **Installation**: Install the app as a PWA on your device for better experience
4. **Notifications**: Enable push notifications to receive incoming calls

### Adding Family Members (Invites)

1. **Create Invite**: The family organizer clicks "Add Contact" and enters a name for the new family member
2. **Generate Invite Link**: The system creates a unique invite link (e.g., `https://yourdomain.com/invite/abc-123-def`)
3. **Share Link**: The organizer shares this link with the family member via any method (SMS, email, messaging app, etc.)
4. **Accept Invite**: The family member opens the link, enters the same name provided by the organizer, and completes registration
5. **Automatic Contact Creation**: Once registered, the new member automatically appears in everyone's contact list

### Making Calls

1. **Initiate Call**: Tap on a contact from your contact list
2. **Choose Call Type**: Select either audio or video call
3. **Call Notification**: The recipient receives a push notification (if enabled) and/or WebSocket notification
4. **Answer Call**: The recipient taps the notification or opens the app to answer
5. **WebRTC Connection**: The app establishes a peer-to-peer connection using the built-in TURN/STUN server
6. **Call Management**: During the call, users can mute audio, toggle video, or end the call

### Link Sending and Invites

- **Invite Links**: Each invite has a unique UUID-based link that can be shared via any method
- **One-Time Use**: Each invite link is tied to a specific contact name and can only be used once
- **Pending Invites**: The family organizer can view all pending invites and resend links if needed
- **Link Format**: Invites use the format `/invite/{uuid}` and are accessible without authentication
- **Security**: Invite links verify both the UUID and the contact name match before allowing registration

## Video and Audio Technology

### WebRTC with Built-in STUN/TURN Server

Family Callbook uses WebRTC (Web Real-Time Communication) for peer-to-peer video and audio transmission. The app includes a built-in TURN/STUN server that ensures reliable connectivity:

- **STUN Server**: Helps discover public IP addresses and NAT types
- **TURN Server**: Relays media traffic when direct peer-to-peer connection is not possible (e.g., symmetric NATs, restrictive firewalls)
- **Automatic Fallback**: The system automatically uses TURN relay when direct connection fails
- **NAT Traversal**: Works seamlessly behind NATs, routers, and firewalls without manual port forwarding

### Bandwidth Optimization

- **Efficient Encoding**: Uses optimized video codecs and adaptive bitrate
- **Low Bandwidth**: Designed to work well with ~500 kbps bidirectional bandwidth per call
- **Quality Adaptation**: Automatically adjusts quality based on available bandwidth
- **Audio Priority**: Prioritizes audio quality for clear voice communication

## Security

### Authentication & Authorization

- **JWT Tokens**: Secure JSON Web Tokens for API authentication
- **Protected Routes**: All sensitive operations require valid authentication tokens
- **Role-Based Access**: Only the family organizer (first user) can invite new members, rename users, or delete contacts
- **Username-Based Login**: Simple username-based authentication (no passwords required for family use)

### Data Protection

- **HTTPS/TLS**: All communication encrypted with TLS 1.2+ using Let's Encrypt certificates
- **WebRTC Encryption**: Media streams encrypted with DTLS-SRTP (Datagram Transport Layer Security - Secure Real-time Transport Protocol)
- **Secure Storage**: Sensitive keys (JWT secrets, VAPID keys, TURN credentials) stored with restricted file permissions (0600)
- **Database Security**: SQLite database with proper access controls

### Network Security

- **TURN Authentication**: TURN server requires username/password authentication
- **Domain Validation**: Server only accepts requests for configured domain (prevents certificate abuse)
- **CORS Protection**: Controlled Cross-Origin Resource Sharing policies
- **Input Validation**: All user inputs validated and sanitized

### Privacy

- **Self-Hosted**: All data stays on your server - no third-party services involved
- **No External Dependencies**: TURN/STUN server runs locally, no reliance on external services
- **Minimal Data Collection**: Only stores necessary user information (username, user ID, invite relationships)
- **No Call Recording**: Calls are peer-to-peer; server does not intercept or record media

## Installation & Setup

### Prerequisites

- Domain name pointing to your server's IP address
- Ports 80 and 443 open and accessible from the internet (for Let's Encrypt)
- Port 3478 (or configured TURN port) open for UDP traffic
- (Optional) Go 1.21 or later if building from source

### Quick Start

#### Option 1: Using Precompiled Binaries (Recommended)

1. **Download Precompiled Binary**
   - Download the appropriate binary for your platform from the [Releases](https://github.com/ZonD80/familycall/releases) page
   - For Linux: `familycall-server-linux-amd64` or `familycall-server-linux-arm64`
   - For macOS: `familycall-server-darwin-amd64` or `familycall-server-darwin-arm64`

2. **Make Binary Executable**
   ```bash
   chmod +x familycall-server-linux-amd64
   ```

3. **Configure Domain**
   - Set `DOMAIN` environment variable: `export DOMAIN=yourdomain.com`
   - Or the server will prompt you on first run

4. **Run in Screen Session** (Recommended for Production)
   ```bash
   # Start a new screen session
   screen -S familycall
   
   # Run the server
   ./familycall-server-linux-amd64
   
   # Detach from screen: Press Ctrl+A then D
   # Reattach later: screen -r familycall
   ```

5. **Access the App**
   - Open `https://yourdomain.com` in your browser
   - Register as the first user (family organizer)
   - Start inviting family members!

#### Option 2: Building from Source

1. **Clone the Repository**
   ```bash
   git clone https://github.com/ZonD80/familycall.git
   cd familycall
   ```

2. **Build the Server**
   ```bash
   cd server
   ./build.sh
   ```

3. **Make Binary Executable**
   ```bash
   chmod +x familycall-server
   ```

4. **Configure Domain**
   - Set `DOMAIN` environment variable: `export DOMAIN=yourdomain.com`
   - Or the server will prompt you on first run

5. **Run in Screen Session** (Recommended for Production)
   ```bash
   # Start a new screen session
   screen -S familycall
   
   # Run the server
   ./familycall-server
   
   # Detach from screen: Press Ctrl+A then D
   # Reattach later: screen -r familycall
   ```

6. **Access the App**
   - Open `https://yourdomain.com` in your browser
   - Register as the first user (family organizer)
   - Start inviting family members!

### Backend-Only Mode

For deployments where SSL/TLS termination is handled by a reverse proxy (e.g., nginx, Traefik, Cloudflare), you can run the server in backend-only mode:

```bash
./familycall-server --backend-only --port 8080 --frontend-uri https://yourdomain.com
```

**Parameters:**
- `--backend-only`: Enables backend-only mode (disables SSL/TLS and Let's Encrypt certificate management)
- `--port` (required with `--backend-only`): HTTP port to bind to (e.g., `8080`)
- `--frontend-uri` (required with `--backend-only`): Base URI of the frontend (e.g., `https://yourdomain.com`)

**Features in backend-only mode:**
- Server runs on HTTP only (no SSL/TLS)
- Let's Encrypt certificate renewal is disabled
- Frontend files are still served
- API calls and WebSocket connections use the specified `frontend-uri`
- CORS headers are configured to allow requests from `frontend-uri`

**Configuration persistence:**
- Configuration is automatically saved to `config.json` in the server directory when using command-line flags
- On subsequent runs, configuration is loaded from `config.json` if it exists
- Command-line flags override values from `config.json`
- A notice is displayed when loading from `config.json`

**Example deployment with nginx:**
```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Environment Variables

- `DOMAIN`: Your domain name (e.g., `family.example.com`) - not used in backend-only mode
- `HTTP_PORT`: HTTP port for Let's Encrypt challenges (default: `80`) - not used in backend-only mode
- `HTTPS_PORT`: HTTPS port (default: `443`) - not used in backend-only mode
- `TURN_PORT`: TURN server UDP port (default: `3478`)
- `TURN_REALM`: TURN server realm (default: `familycall`)
- `DATABASE_PATH`: Path to SQLite database file (default: `familycall.db`)
- `JWT_SECRET`: JWT signing secret (auto-generated if not set)
- `VAPID_PUBLIC_KEY`: VAPID public key for push notifications (auto-generated if not set)
- `VAPID_PRIVATE_KEY`: VAPID private key for push notifications (auto-generated if not set)
- `VAPID_SUBJECT`: VAPID subject (default: `mailto:admin@familycall.app`)

### File Structure

- `server/`: Go server application
  - `main.go`: Main server entry point
  - `internal/`: Internal packages
    - `config/`: Configuration management
    - `database/`: Database initialization
    - `handlers/`: HTTP request handlers
    - `models/`: Data models
    - `turn/`: TURN server implementation
    - `websocket/`: WebSocket hub for real-time communication
  - `web/`: Embedded web application (PWA)
  - `translations/`: i18n translation files
- `keys/`: Auto-generated keys directory (created at runtime)
- `certs/`: Let's Encrypt certificates directory (created at runtime)
- `config.json`: Server configuration file (created when using command-line flags)

## Usage Guide

### For Family Organizers

1. **Register**: Be the first to register and become the family organizer
2. **Add Contacts**: Click "Add Contact" to create invites for family members
3. **Share Invite Links**: Copy and share invite links with family members
4. **Manage Contacts**: View pending invites, rename users, or remove contacts as needed
5. **Backup & Restore**: Use the backup/restore feature to safeguard your server data
   - **Backup**: Click "Backup" in the menu (☰) to download a ZIP archive containing keys, certificates, and database
   - **Restore**: Click "Restore" in the menu to upload a previously created backup ZIP file
   - **Important**: After restoring, restart the server for changes to take effect

### For Family Members


1. **Open Link**: Click the invite link in your browser
2. **Start Calling**: Tap contacts to initiate audio or video calls

## Backup & Restore

### Overview

The backup and restore functionality allows the family organizer (first user) to create complete backups of critical server data and restore them when needed. This is useful for:
- **Server Migration**: Moving to a new server or machine
- **Disaster Recovery**: Restoring after data loss or corruption
- **Regular Backups**: Creating periodic backups for safety

### What Gets Backed Up

The backup ZIP archive includes:
- **Keys Directory** (`keys/`): JWT secret, VAPID public/private keys, and VAPID subject
- **Certificates Directory** (`certs/`): Let's Encrypt SSL certificates and domain configuration
- **Database File**: Complete SQLite database with all users, contacts, invites, and push subscriptions
- **Configuration File** (`config.json`): Server configuration including backend-only mode settings (if present)

### Creating a Backup

1. **Access Menu**: Click the menu icon (☰) in the top-right corner
2. **Click Backup**: Select "Backup" from the menu (only visible to family organizer)
3. **Download**: The browser will download a ZIP file named `familycall-backup-YYYYMMDD-HHMMSS.zip`
4. **Store Safely**: Save the backup file in a secure location

### Restoring from Backup

1. **Access Menu**: Click the menu icon (☰) in the top-right corner
2. **Click Restore**: Select "Restore" from the menu
3. **Select Backup File**: Choose the previously created backup ZIP file
4. **Confirm**: Confirm the restore operation (this will replace current keys, certificates, and database)
5. **Restart Server**: **Important**: Restart the server after restoring for changes to take effect

### Security Notes

- **Access Control**: Only the family organizer (first user) can create or restore backups
- **File Permissions**: Restored files maintain proper security permissions (0600 for keys/certs)
- **Path Security**: Restore handler includes protection against path traversal attacks
- **Server Restart**: Always restart the server after restore to ensure all components use the restored data

### Best Practices

- **Regular Backups**: Create backups before major updates or server changes
- **Offsite Storage**: Store backups in a secure, separate location (cloud storage, external drive, etc.)
- **Test Restores**: Periodically test restore functionality to ensure backups are valid
- **Version Control**: Keep multiple backup versions with timestamps
- **Secure Storage**: Treat backup files as sensitive - they contain all authentication keys and user data

## Troubleshooting

### Calls Not Connecting

- **Check TURN Server**: Ensure TURN port (default 3478) is open for UDP traffic
- **Firewall Settings**: Verify ports 80, 443, and TURN port are accessible
- **Browser Permissions**: Ensure microphone/camera permissions are granted
- **Network Issues**: Try switching networks or using mobile data

### Push Notifications Not Working

- **Browser Support**: Ensure browser supports Web Push API (Chrome, Firefox, Edge)
- **HTTPS Required**: Push notifications require HTTPS (not HTTP)
- **Permissions**: Check browser notification permissions
- **Service Worker**: Ensure service worker is registered and active

### Certificate Issues

- **Domain Configuration**: Verify domain DNS points to server IP
- **Port Access**: Ensure ports 80 and 443 are accessible from internet
- **Let's Encrypt Limits**: Be aware of rate limits (5 certificates per domain per week)

## Development

### Building from Source

```bash
cd server
./build.sh
```

### Running Tests

```bash
cd server
go test ./...
```

### Contributing

Contributions are welcome! Please ensure:
- Code follows Go best practices
- Tests are included for new features
- Documentation is updated

## License

This project is licensed under the GNU General Public License v3.0 (GPLv3). See [LICENSE.md](LICENSE.md) for details.

## Support

For issues, questions, or contributions, please open an issue on the GitHub repository.

## Acknowledgments

- Built with [Go](https://golang.org/) and [Gin](https://gin-gonic.com/)
- WebRTC powered by browser native APIs
- TURN server using [Pion TURN](https://github.com/pion/turn)
- Push notifications via [Web Push API](https://web.dev/push-notifications-overview/)

