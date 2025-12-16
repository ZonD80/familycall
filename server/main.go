package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"familycall/server/internal/config"
	"familycall/server/internal/database"
	"familycall/server/internal/handlers"
	"familycall/server/internal/turn"
	"familycall/server/internal/websocket"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/acme/autocert"
)

const AppVersion = "1.0.0"

//go:embed web/*
var staticFiles embed.FS

//go:embed translations/*.json
var translationsFS embed.FS

// Build timestamp - set at compile time or use current time
var buildTimestamp = time.Now().Unix()

func main() {
	// Parse command-line flags
	backendOnly := flag.Bool("backend-only", false, "Run in backend-only mode (disable SSL/LE, use HTTP)")
	backendPort := flag.String("port", "", "HTTP port for backend-only mode (required with --backend-only)")
	frontendURI := flag.String("frontend-uri", "", "Frontend URI base (e.g., https://domain.host) (required with --backend-only)")
	flag.Parse()

	// Validate flags
	if *backendOnly {
		if *backendPort == "" {
			log.Fatal("Error: --port is required when --backend-only is specified")
		}
		if *frontendURI == "" {
			log.Fatal("Error: --frontend-uri is required when --backend-only is specified")
		}
		// Normalize frontend URI (remove trailing slash)
		*frontendURI = strings.TrimSuffix(*frontendURI, "/")
	}

	// Log version and build info
	log.Printf("Family Callbook Server v%s (build: %d)", AppVersion, buildTimestamp)

	// Load configuration (from config.json if exists, override with flags)
	cfg := config.Load(backendOnly, backendPort, frontendURI)

	// Save config.json if flags were provided
	if *backendOnly || (*backendPort != "" || *frontendURI != "") {
		if err := config.SaveConfigToJSON(cfg); err != nil {
			log.Printf("Warning: Failed to save config.json: %v", err)
		} else {
			log.Printf("Configuration saved to config.json")
		}
	}

	// Initialize database
	db, err := database.Initialize(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}

	// Initialize WebSocket hub
	hub := websocket.NewHub()
	go hub.Run()

	// Initialize TURN server
	turnServer, err := turn.Initialize(cfg.TURNPort, cfg.TURNRealm)
	if err != nil {
		log.Fatalf("Failed to initialize TURN server: %v", err)
	}
	defer turnServer.Close()

	log.Printf("TURN server started on port %d", cfg.TURNPort)

	// Initialize handlers
	h := handlers.New(db, hub, cfg, turnServer, translationsFS)

	// Setup router
	router := setupRouter(h, cfg)

	// Setup server (HTTPS with Let's Encrypt or HTTP for backend-only)
	startHTTPServer(router, cfg)
}

func setupRouter(h *handlers.Handlers, cfg *config.Config) *gin.Engine {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.Default()

	// CORS middleware (for web app)
	router.Use(func(c *gin.Context) {
		// Use frontend URI for CORS if in backend-only mode, otherwise allow all
		origin := "*"
		if cfg.BackendOnly && cfg.FrontendURI != "" {
			origin = cfg.FrontendURI
		}
		c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	})

	// Public routes
	api := router.Group("/api")
	{
		api.POST("/register", h.Register)
		api.POST("/login", h.Login)
		api.GET("/registration-status", h.CheckRegistrationStatus)
		api.GET("/invite/:uuid", h.GetInvite)
		api.GET("/vapid-public-key", h.GetVAPIDPublicKey)
		api.GET("/turn-config", h.GetTURNConfig)
		api.GET("/translations/:lang", h.GetTranslations)
	}

	// Protected routes
	protected := api.Group("")
	protected.Use(h.AuthMiddleware())
	{
		protected.GET("/me", h.GetMe)
		protected.POST("/users/rename", h.RenameUser)
		protected.GET("/contacts", h.GetContacts)
		protected.POST("/contacts", h.CreateContact)
		protected.DELETE("/contacts/:id", h.DeleteContact)
		protected.GET("/contacts/:contact_id/invite", h.GetInviteForContact)
		protected.GET("/invites/pending", h.GetPendingInvites)
		protected.DELETE("/invites/:id", h.DeleteInvite)
		protected.POST("/invite", h.CreateInvite)
		protected.POST("/invite/:uuid/accept", h.AcceptInvite)
		protected.POST("/call", h.InitiateCall)
		protected.POST("/push/subscribe", h.SubscribePush)
		protected.DELETE("/push/subscribe", h.UnsubscribePush)
		protected.GET("/backup", h.Backup)
		protected.POST("/restore", h.Restore)
	}

	// WebSocket route
	router.GET("/ws", h.HandleWebSocket)

	// Manifest.json route (ensure correct content-type)
	router.GET("/manifest.json", func(c *gin.Context) {
		fsys, _ := fs.Sub(staticFiles, "web")
		manifestFile, err := fsys.Open("manifest.json")
		if err != nil {
			c.String(http.StatusNotFound, "Manifest not found")
			return
		}
		defer manifestFile.Close()
		stat, _ := manifestFile.Stat()
		c.DataFromReader(http.StatusOK, stat.Size(), "application/manifest+json", manifestFile, nil)
	})

	// Service worker route (ensure correct content-type and inject cache version)
	router.GET("/service-worker.js", func(c *gin.Context) {
		fsys, _ := fs.Sub(staticFiles, "web")
		swFile, err := fsys.Open("service-worker.js")
		if err != nil {
			c.String(http.StatusNotFound, "Service worker not found")
			return
		}
		defer swFile.Close()

		// Read the service worker content
		swContent, err := io.ReadAll(swFile)
		if err != nil {
			c.String(http.StatusInternalServerError, "Failed to read service worker")
			return
		}

		// Inject build timestamp into cache name
		swStr := string(swContent)
		cacheName := fmt.Sprintf("familycall-v3-%d", buildTimestamp)
		swStr = strings.ReplaceAll(swStr, `const CACHE_NAME = 'familycall-v3';`, fmt.Sprintf(`const CACHE_NAME = '%s';`, cacheName))

		c.Header("Content-Type", "application/javascript; charset=utf-8")
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.String(http.StatusOK, swStr)
	})

	// Public invite page route (for sharing invite links)
	router.GET("/invite/:uuid", func(c *gin.Context) {
		serveIndexHTML(c, cfg)
	})

	router.GET("/call", func(c *gin.Context) {
		serveIndexHTML(c, cfg)
	})

	// Root route
	router.GET("/", func(c *gin.Context) {
		serveIndexHTML(c, cfg)
	})

	// Serve static files (PWA)
	router.NoRoute(serveStaticFiles(cfg))

	return router
}

// serveIndexHTML serves index.html with versioned script tags
func serveIndexHTML(c *gin.Context, cfg *config.Config) {
	fsys, _ := fs.Sub(staticFiles, "web")
	indexFile, err := fsys.Open("index.html")
	if err != nil {
		c.String(http.StatusNotFound, "Not found")
		return
	}
	defer indexFile.Close()

	// Read the HTML content
	htmlContent, err := io.ReadAll(indexFile)
	if err != nil {
		c.String(http.StatusInternalServerError, "Failed to read index.html")
		return
	}

	// Generate version string (version + timestamp)
	version := fmt.Sprintf("%s-%d", AppVersion, buildTimestamp)

	// Replace script and stylesheet tags with versioned URLs
	htmlStr := string(htmlContent)
	htmlStr = strings.ReplaceAll(htmlStr, `src="/app.js"`, fmt.Sprintf(`src="/app.js?v=%s"`, version))
	htmlStr = strings.ReplaceAll(htmlStr, `href="/styles.css"`, fmt.Sprintf(`href="/styles.css?v=%s"`, version))
	htmlStr = strings.ReplaceAll(htmlStr, `href="/service-worker.js"`, fmt.Sprintf(`href="/service-worker.js?v=%s"`, version))

	// Inject frontend URI as API base if in backend-only mode
	if cfg.BackendOnly && cfg.FrontendURI != "" {
		// Inject API_BASE constant before the first script tag
		apiBaseScript := fmt.Sprintf(`<script>window.API_BASE = '%s/api';</script>`, cfg.FrontendURI)
		// Find the first script tag and inject before it
		if idx := strings.Index(htmlStr, "<script"); idx != -1 {
			htmlStr = htmlStr[:idx] + apiBaseScript + "\n" + htmlStr[idx:]
		}
	}

	// Inject version into HTML for display
	htmlStr = strings.ReplaceAll(htmlStr, `<h2>Family Callbook</h2>`, fmt.Sprintf(`<h2>Family Callbook</h2><p class="app-version">v%s</p>`, AppVersion))
	htmlStr = strings.ReplaceAll(htmlStr, `<h1>Family Callbook</h1>`, fmt.Sprintf(`<h1>Family Callbook</h1><p class="app-version">v%s</p>`, AppVersion))

	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Header("Pragma", "no-cache")
	c.Header("Expires", "0")
	c.String(http.StatusOK, htmlStr)
}

// serveStaticFiles serves embedded static files
func serveStaticFiles(cfg *config.Config) gin.HandlerFunc {
	// Get the subdirectory
	fsys, err := fs.Sub(staticFiles, "web")
	if err != nil {
		panic("Failed to create sub filesystem: " + err.Error())
	}

	fileServer := http.FileServer(http.FS(fsys))

	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// Skip API routes, WebSocket, and invite routes (handled separately)
		if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/ws") {
			c.Next()
			return
		}

		// Remove leading slash
		path = strings.TrimPrefix(path, "/")

		// Check if file exists
		_, err := fsys.Open(path)
		if err != nil {
			// File doesn't exist, serve index.html for SPA routing
			serveIndexHTML(c, cfg)
			return
		}

		// If serving index.html, use versioned version
		if path == "index.html" {
			serveIndexHTML(c, cfg)
			return
		}

		// Set proper content type and cache headers
		ext := filepath.Ext(path)
		switch ext {
		case ".html":
			c.Header("Content-Type", "text/html; charset=utf-8")
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		case ".css":
			c.Header("Content-Type", "text/css; charset=utf-8")
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		case ".js":
			c.Header("Content-Type", "application/javascript; charset=utf-8")
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		case ".json":
			c.Header("Content-Type", "application/json; charset=utf-8")
		case ".png":
			c.Header("Content-Type", "image/png")
		case ".jpg", ".jpeg":
			c.Header("Content-Type", "image/jpeg")
		case ".svg":
			c.Header("Content-Type", "image/svg+xml")
		case ".ico":
			c.Header("Content-Type", "image/x-icon")
		}

		fileServer.ServeHTTP(c.Writer, c.Request)
		c.Abort()
	}
}

func startHTTPServer(router *gin.Engine, cfg *config.Config) {
	// Backend-only mode: simple HTTP server
	if cfg.BackendOnly {
		httpServer := &http.Server{
			Addr:         ":" + cfg.BackendPort,
			Handler:      router,
			ReadTimeout:  15 * time.Second,
			WriteTimeout: 15 * time.Second,
			IdleTimeout:  60 * time.Second,
		}

		log.Printf("Backend-only mode: HTTP server starting on port %s", cfg.BackendPort)
		log.Printf("Frontend URI: %s", cfg.FrontendURI)
		log.Printf("SSL/TLS and Let's Encrypt certificate management disabled")
		log.Printf("API calls will use: %s/api", cfg.FrontendURI)

		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start HTTP server: %v", err)
		}
		return
	}

	// Normal mode: HTTPS with Let's Encrypt
	// Get certs directory
	certsDir := getCertsDirectory()
	if err := os.MkdirAll(certsDir, 0700); err != nil {
		log.Fatalf("Failed to create certs directory: %v", err)
	}

	// Normalize domain (remove www. prefix if present, convert to lowercase)
	normalizedDomain := normalizeDomain(cfg.Domain)
	log.Printf("Configured domain: %s (normalized: %s)", cfg.Domain, normalizedDomain)

	// Configure autocert manager with custom HostPolicy for better error handling
	m := &autocert.Manager{
		Prompt: autocert.AcceptTOS,
		HostPolicy: func(ctx context.Context, host string) error {
			normalizedHost := normalizeDomain(host)
			if normalizedHost != normalizedDomain {
				// Silently reject - don't log to avoid spam from bots/scanners
				return fmt.Errorf("host %q not configured (expected %q)", host, normalizedDomain)
			}
			return nil
		},
		Cache: autocert.DirCache(certsDir),
	}

	// Create HTTP handler that redirects to HTTPS, but allows ACME challenges
	// Use autocert's HTTP handler for ACME challenges, then redirect everything else
	redirectHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Redirect all HTTP traffic to HTTPS
		httpsURL := "https://" + r.Host + r.RequestURI
		http.Redirect(w, r, httpsURL, http.StatusMovedPermanently)
	})

	// Chain handlers: autocert first (for ACME challenges), then redirect
	httpHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check if this is an ACME challenge
		if strings.HasPrefix(r.URL.Path, "/.well-known/acme-challenge/") {
			m.HTTPHandler(nil).ServeHTTP(w, r)
			return
		}
		// Otherwise redirect to HTTPS
		redirectHandler.ServeHTTP(w, r)
	})

	// Create a custom error logger that filters out TLS handshake errors for unauthorized hosts
	errorLog := log.New(&tlsErrorFilter{writer: os.Stderr}, "", log.LstdFlags)

	// Create HTTP server for Let's Encrypt challenge and redirects (port 80)
	httpServer := &http.Server{
		Addr:         ":" + cfg.HTTPPort,
		Handler:      httpHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
		ErrorLog:     errorLog,
	}

	// Create HTTPS server (port 443) with custom error logger to suppress TLS handshake errors
	httpsServer := &http.Server{
		Addr:         ":" + cfg.HTTPSPort,
		Handler:      router,
		TLSConfig:    m.TLSConfig(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
		ErrorLog:     errorLog,
	}

	// Start HTTP server in goroutine (for Let's Encrypt challenge and redirects)
	go func() {
		log.Printf("HTTP server (ACME challenge & redirects) starting on port %s", cfg.HTTPPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start HTTP server: %v", err)
		}
	}()

	// Start certificate renewal goroutine
	go startCertificateRenewal(m, normalizedDomain, certsDir)

	// Start HTTPS server
	log.Printf("HTTPS server starting on port %s for domain: %s", cfg.HTTPSPort, normalizedDomain)
	log.Printf("Certificates will be stored in: %s", certsDir)
	log.Printf("Only requests for '%s' will be accepted. Other domains will be rejected.", normalizedDomain)
	if normalizedDomain == "localhost" || normalizedDomain == "127.0.0.1" {
		log.Println("WARNING: Using localhost. Let's Encrypt will not work.")
		log.Println("         Make sure your domain DNS points to this server for production use.")
	}

	if err := httpsServer.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start HTTPS server: %v", err)
	}
}

// startCertificateRenewal runs a background goroutine that checks and renews certificates monthly
func startCertificateRenewal(m *autocert.Manager, domain string, certsDir string) {
	// Wait a bit for initial certificate to be obtained
	time.Sleep(30 * time.Second)

	// Run renewal check every month (30 days)
	ticker := time.NewTicker(30 * 24 * time.Hour)
	defer ticker.Stop()

	// Run immediately on startup, then every month
	checkAndRenewCertificate(m, domain, certsDir)

	for range ticker.C {
		checkAndRenewCertificate(m, domain, certsDir)
	}
}

// checkAndRenewCertificate checks if certificate needs renewal and triggers renewal if needed
func checkAndRenewCertificate(m *autocert.Manager, domain string, certsDir string) {
	log.Printf("[CERT] Checking certificate expiration for domain: %s", domain)

	// Get certificate from cache
	cert, err := m.GetCertificate(&tls.ClientHelloInfo{
		ServerName: domain,
	})
	if err != nil {
		log.Printf("[CERT] Error getting certificate: %v (will be obtained on next request)", err)
		return
	}

	if cert == nil || len(cert.Certificate) == 0 {
		log.Printf("[CERT] No certificate found in cache (will be obtained on next request)")
		return
	}

	// Parse certificate to check expiration
	var x509Cert *x509.Certificate
	if cert.Leaf != nil {
		// Certificate already parsed
		x509Cert = cert.Leaf
	} else if len(cert.Certificate) > 0 {
		// Parse from raw certificate bytes
		var err error
		x509Cert, err = x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			log.Printf("[CERT] Error parsing certificate: %v", err)
			// Trigger renewal anyway by accessing the certificate
			log.Printf("[CERT] Triggering certificate check/renewal for domain: %s", domain)
			_, _ = m.GetCertificate(&tls.ClientHelloInfo{ServerName: domain})
			return
		}
	} else {
		log.Printf("[CERT] No certificate data available")
		return
	}

	// Check if certificate expires within 30 days
	now := time.Now()
	expiresIn := x509Cert.NotAfter.Sub(now)
	daysUntilExpiry := int(expiresIn.Hours() / 24)

	log.Printf("[CERT] Certificate expires in %d days (expires: %s)", daysUntilExpiry, x509Cert.NotAfter.Format("2006-01-02"))

	if daysUntilExpiry < 30 {
		log.Printf("[CERT] Certificate expires soon (%d days), triggering renewal...", daysUntilExpiry)
		// Force renewal by getting a new certificate
		// This will trigger autocert's renewal logic
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		// Create a dummy request to trigger certificate renewal
		// The autocert manager will handle the renewal automatically
		_, err := m.GetCertificate(&tls.ClientHelloInfo{
			ServerName: domain,
		})
		if err != nil {
			log.Printf("[CERT] Error during renewal: %v", err)
		} else {
			log.Printf("[CERT] Certificate renewal triggered successfully")
		}
		_ = ctx
	} else {
		log.Printf("[CERT] Certificate is still valid for %d more days, no renewal needed", daysUntilExpiry)
	}
}

func getCertsDirectory() string {
	// Get directory where the executable is located
	execPath, err := os.Executable()
	if err != nil {
		// Fallback to current directory
		return "certs"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "certs")
}

// tlsErrorFilter filters out TLS handshake errors for unauthorized hosts
type tlsErrorFilter struct {
	writer io.Writer
}

func (f *tlsErrorFilter) Write(p []byte) (n int, err error) {
	msg := string(p)
	// Filter out TLS handshake errors for unauthorized hosts
	if strings.Contains(msg, "TLS handshake error") && strings.Contains(msg, "not configured") {
		return len(p), nil // Discard the message
	}
	return f.writer.Write(p)
}

// normalizeDomain normalizes a domain name for comparison
// - Converts to lowercase
// - Removes www. prefix if present
// - Trims whitespace
func normalizeDomain(domain string) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	// Remove www. prefix if present
	domain = strings.TrimPrefix(domain, "www.")
	return domain
}
