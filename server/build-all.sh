#!/bin/bash

# Build script for familycall server - cross-platform builds
# Compiles Go backend into single binaries for multiple platforms

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}Building familycall server for multiple platforms...${NC}"

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Create builds directory
BUILD_DIR="$SCRIPT_DIR/builds"
mkdir -p "$BUILD_DIR"

# Platforms to build for
PLATFORMS=(
    "linux/amd64"
    "linux/arm64"
    "darwin/amd64"
    "darwin/arm64"
    "windows/amd64"
)

# Build for each platform
for PLATFORM in "${PLATFORMS[@]}"; do
    GOOS=${PLATFORM%/*}
    GOARCH=${PLATFORM#*/}
    
    echo -e "${YELLOW}Building for $GOOS/$GOARCH...${NC}"
    
    OUTPUT_NAME="familycall-server-${GOOS}-${GOARCH}"
    if [ "$GOOS" = "windows" ]; then
        OUTPUT_NAME="${OUTPUT_NAME}.exe"
    fi
    
    OUTPUT_PATH="$BUILD_DIR/${OUTPUT_NAME}"
    
    env GOOS=$GOOS GOARCH=$GOARCH go build -o "$OUTPUT_PATH" .
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Built: $OUTPUT_PATH${NC}"
    else
        echo -e "${RED}✗ Failed to build for $GOOS/$GOARCH${NC}"
    fi
done

echo -e "${GREEN}All builds completed!${NC}"
echo -e "${BLUE}Binaries are in: $BUILD_DIR${NC}"

