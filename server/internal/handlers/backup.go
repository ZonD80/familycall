package handlers

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"familycall/server/internal/models"

	"github.com/gin-gonic/gin"
)

// Backup creates a ZIP archive containing keys, certs, and database
func (h *Handlers) Backup(c *gin.Context) {
	// Check if user is the first user
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	var user models.User
	if err := h.db.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	// Check if this is the first user
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := user.InvitedByUserID == nil || userCount == 1

	if userCount > 1 && user.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == user.ID
	}

	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can create backups"})
		return
	}

	// Get directories
	keysDir := h.getKeysDirectory()
	certsDir := h.getCertsDirectory()
	dbPath := h.config.DatabasePath
	configPath := h.getConfigFilePath()

	// Create temporary ZIP file
	timestamp := time.Now().Format("20060102-150405")
	zipFilename := fmt.Sprintf("familycall-backup-%s.zip", timestamp)
	tempZipPath := filepath.Join(os.TempDir(), zipFilename)

	// Create ZIP file
	zipFile, err := os.Create(tempZipPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create backup file: %v", err)})
		return
	}
	defer zipFile.Close()
	defer os.Remove(tempZipPath) // Clean up temp file

	zipWriter := zip.NewWriter(zipFile)
	defer zipWriter.Close()

	// Function to add directory to ZIP
	addDirToZip := func(dirPath, zipPrefix string) error {
		if _, err := os.Stat(dirPath); os.IsNotExist(err) {
			return nil // Directory doesn't exist, skip
		}

		return filepath.Walk(dirPath, func(filePath string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			// Skip directories
			if info.IsDir() {
				return nil
			}

			// Get relative path
			relPath, err := filepath.Rel(dirPath, filePath)
			if err != nil {
				return err
			}

			// Create zip entry path
			zipPath := filepath.Join(zipPrefix, relPath)
			zipPath = strings.ReplaceAll(zipPath, "\\", "/") // Use forward slashes in ZIP

			// Create file in ZIP
			fileInZip, err := zipWriter.Create(zipPath)
			if err != nil {
				return err
			}

			// Open source file
			sourceFile, err := os.Open(filePath)
			if err != nil {
				return err
			}
			defer sourceFile.Close()

			// Copy file content to ZIP
			_, err = io.Copy(fileInZip, sourceFile)
			return err
		})
	}

	// Add keys directory
	if err := addDirToZip(keysDir, "keys"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to backup keys: %v", err)})
		return
	}

	// Add certs directory
	if err := addDirToZip(certsDir, "certs"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to backup certs: %v", err)})
		return
	}

	// Add database file
	if _, err := os.Stat(dbPath); err == nil {
		dbFile, err := zipWriter.Create("database/" + filepath.Base(dbPath))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create database entry in ZIP: %v", err)})
			return
		}

		sourceDb, err := os.Open(dbPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to open database: %v", err)})
			return
		}
		defer sourceDb.Close()

		if _, err := io.Copy(dbFile, sourceDb); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to copy database to ZIP: %v", err)})
			return
		}
	}

	// Add config.json file if it exists
	if _, err := os.Stat(configPath); err == nil {
		configFile, err := zipWriter.Create("config.json")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create config.json entry in ZIP: %v", err)})
			return
		}

		sourceConfig, err := os.Open(configPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to open config.json: %v", err)})
			return
		}
		defer sourceConfig.Close()

		if _, err := io.Copy(configFile, sourceConfig); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to copy config.json to ZIP: %v", err)})
			return
		}
	}

	// Close ZIP writer to finalize
	if err := zipWriter.Close(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to finalize ZIP: %v", err)})
		return
	}

	// Close file before reading
	zipFile.Close()

	// Reopen file for reading
	zipFile, err = os.Open(tempZipPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to reopen backup file: %v", err)})
		return
	}
	defer zipFile.Close()

	// Get file info for size
	fileInfo, err := zipFile.Stat()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to get file info: %v", err)})
		return
	}

	// Set headers for file download
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%s", zipFilename))
	c.Header("Content-Length", fmt.Sprintf("%d", fileInfo.Size()))

	// Stream file to client
	c.File(tempZipPath)
}

// Restore restores keys, certs, and database from a ZIP archive
func (h *Handlers) Restore(c *gin.Context) {
	// Check if user is the first user
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	var user models.User
	if err := h.db.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	// Check if this is the first user
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := user.InvitedByUserID == nil || userCount == 1

	if userCount > 1 && user.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == user.ID
	}

	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can restore backups"})
		return
	}

	// Get uploaded file
	file, err := c.FormFile("backup")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No backup file provided"})
		return
	}

	// Open uploaded file
	src, err := file.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to open uploaded file: %v", err)})
		return
	}
	defer src.Close()

	// Create temporary file for ZIP
	tempZipPath := filepath.Join(os.TempDir(), fmt.Sprintf("restore-%d.zip", time.Now().UnixNano()))
	tempZipFile, err := os.Create(tempZipPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to create temp file: %v", err)})
		return
	}
	defer os.Remove(tempZipPath) // Clean up

	// Copy uploaded file to temp location
	if _, err := io.Copy(tempZipFile, src); err != nil {
		tempZipFile.Close()
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to save uploaded file: %v", err)})
		return
	}
	tempZipFile.Close()

	// Open ZIP file
	zipReader, err := zip.OpenReader(tempZipPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid ZIP file: %v", err)})
		return
	}
	defer zipReader.Close()

	// Get directories
	keysDir := h.getKeysDirectory()
	certsDir := h.getCertsDirectory()
	dbPath := h.config.DatabasePath
	configPath := h.getConfigFilePath()

	// Extract files
	for _, f := range zipReader.File {
		// Security: prevent path traversal
		if strings.Contains(f.Name, "..") {
			continue
		}

		// Extract keys
		if strings.HasPrefix(f.Name, "keys/") {
			relPath := strings.TrimPrefix(f.Name, "keys/")
			if relPath == "" {
				continue
			}
			targetPath := filepath.Join(keysDir, relPath)

			if err := extractFile(f, targetPath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to extract keys: %v", err)})
				return
			}
		}

		// Extract certs
		if strings.HasPrefix(f.Name, "certs/") {
			relPath := strings.TrimPrefix(f.Name, "certs/")
			if relPath == "" {
				continue
			}
			targetPath := filepath.Join(certsDir, relPath)

			if err := extractFile(f, targetPath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to extract certs: %v", err)})
				return
			}
		}

		// Extract database
		if strings.HasPrefix(f.Name, "database/") {
			relPath := strings.TrimPrefix(f.Name, "database/")
			if relPath == "" {
				continue
			}
			// Use configured database path
			targetPath := dbPath

			if err := extractFile(f, targetPath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to extract database: %v", err)})
				return
			}
		}

		// Extract config.json
		if f.Name == "config.json" {
			if err := extractFile(f, configPath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to extract config.json: %v", err)})
				return
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Backup restored successfully. Please restart the server for changes to take effect.",
	})
}

// extractFile extracts a file from ZIP archive
func extractFile(f *zip.File, targetPath string) error {
	// Create directory if needed
	if err := os.MkdirAll(filepath.Dir(targetPath), 0700); err != nil {
		return err
	}

	// Open file from ZIP
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	// Create target file
	targetFile, err := os.Create(targetPath)
	if err != nil {
		return err
	}
	defer targetFile.Close()

	// Copy content
	_, err = io.Copy(targetFile, rc)
	if err != nil {
		return err
	}

	// Set permissions (0600 for keys/certs/config.json, 0644 for database)
	if strings.Contains(targetPath, "keys") || strings.Contains(targetPath, "certs") || strings.HasSuffix(targetPath, "config.json") {
		return os.Chmod(targetPath, 0600)
	}
	return os.Chmod(targetPath, 0644)
}

// getKeysDirectory returns the keys directory path
func (h *Handlers) getKeysDirectory() string {
	execPath, err := os.Executable()
	if err != nil {
		return "keys"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "keys")
}

// getCertsDirectory returns the certs directory path
func (h *Handlers) getCertsDirectory() string {
	execPath, err := os.Executable()
	if err != nil {
		return "certs"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "certs")
}

// getConfigFilePath returns the config.json file path
func (h *Handlers) getConfigFilePath() string {
	execPath, err := os.Executable()
	if err != nil {
		return "config.json"
	}
	execDir := filepath.Dir(execPath)
	return filepath.Join(execDir, "config.json")
}

