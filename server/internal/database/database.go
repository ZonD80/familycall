package database

import (
	"familycall/server/internal/models"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func Initialize(dbPath string) (*gorm.DB, error) {
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		return nil, err
	}

	// Auto-migrate models
	if err := db.AutoMigrate(
		&models.User{},
		&models.Invite{},
		&models.PushSubscription{},
	); err != nil {
		return nil, err
	}
	
	// Drop Contact table if it exists (migration from old schema)
	db.Exec("DROP TABLE IF EXISTS contacts")

	return db, nil
}

