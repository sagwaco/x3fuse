#!/bin/bash

# X3Fuse Universal Binary Verification Script
# This script verifies that the app and its components are properly built as universal binaries

echo "================================================"
echo "X3Fuse Universal Binary Verification"
echo "================================================"
echo ""

# Check if X3Fuse.app exists - look for the most recent build
# First try current directory
if [ -d "X3Fuse.app" ]; then
    APP_PATH="X3Fuse.app"
# Then check standard Xcode DerivedData locations
else
    # Find the most recent X3Fuse.app in DerivedData
    LATEST_APP=""
    LATEST_TIME=0
    
    # Search for all X3Fuse.app instances in DerivedData
    while IFS= read -r app_path; do
        if [ -f "$app_path/Contents/MacOS/X3Fuse" ]; then
            # Get modification time
            if [[ "$OSTYPE" == "darwin"* ]]; then
                MOD_TIME=$(stat -f %m "$app_path")
            else
                MOD_TIME=$(stat -c %Y "$app_path")
            fi
            
            # Keep track of the most recent
            if [ "$MOD_TIME" -gt "$LATEST_TIME" ]; then
                LATEST_TIME=$MOD_TIME
                LATEST_APP=$app_path
            fi
        fi
    done < <(find ~/Library/Developer/Xcode/DerivedData -name "X3Fuse.app" -type d 2>/dev/null)
    
    if [ -n "$LATEST_APP" ]; then
        APP_PATH="$LATEST_APP"
        echo "Found most recent build in DerivedData"
    else
        echo "❌ X3Fuse.app not found. Please build the app first."
        echo ""
        echo "Try one of these commands:"
        echo "  • For Release build: xcodebuild -project X3Fuse.xcodeproj -scheme X3Fuse -configuration Release build"
        echo "  • For Debug build: xcodebuild -project X3Fuse.xcodeproj -scheme X3Fuse -configuration Debug build"
        echo ""
        echo "Or build from Xcode IDE: Product → Build (⌘B)"
        exit 1
    fi
fi

echo "Found app at: $APP_PATH"
echo ""

# Function to check binary architecture
check_binary() {
    local binary_path=$1
    local binary_name=$2
    
    if [ -f "$binary_path" ]; then
        echo "Checking $binary_name:"
        arch_info=$(lipo -info "$binary_path" 2>&1)
        echo "  $arch_info"
        
        if echo "$arch_info" | grep -q "x86_64 arm64"; then
            echo "  ✅ Universal binary (Intel + Apple Silicon)"
        elif echo "$arch_info" | grep -q "x86_64"; then
            echo "  ⚠️  Intel-only binary"
        elif echo "$arch_info" | grep -q "arm64"; then
            echo "  ⚠️  Apple Silicon-only binary"
        else
            echo "  ❌ Unknown architecture"
        fi
    else
        echo "  ⚠️  $binary_name not found at $binary_path"
    fi
    echo ""
}

# Check main app executable
check_binary "$APP_PATH/Contents/MacOS/X3Fuse" "Main App Executable"

# Check embedded binaries
check_binary "$APP_PATH/Contents/Resources/x3f_extract" "x3f_extract"
check_binary "$APP_PATH/Contents/Resources/exiftool" "exiftool (Perl script)"

# Check code signing
echo "================================================"
echo "Code Signing Status:"
echo "================================================"
codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -E "Identifier|Format|Authority|TeamIdentifier|Runtime"
echo ""

# Check for notarization
echo "================================================"
echo "Notarization Status:"
echo "================================================"
spctl -a -vvv -t execute "$APP_PATH" 2>&1
echo ""

# Check Info.plist
echo "================================================"
echo "App Version Info:"
echo "================================================"
if [ -f "$APP_PATH/Contents/Info.plist" ]; then
    echo "Bundle ID: $(defaults read "$APP_PATH/Contents/Info" CFBundleIdentifier 2>/dev/null || echo "Not found")"
    echo "Version: $(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "Not found")"
    echo "Build: $(defaults read "$APP_PATH/Contents/Info" CFBundleVersion 2>/dev/null || echo "Not found")"
else
    echo "❌ Info.plist not found"
fi
echo ""

# Summary
echo "================================================"
echo "Summary:"
echo "================================================"

issues=0

# Check main binary
if ! lipo -info "$APP_PATH/Contents/MacOS/X3Fuse" 2>&1 | grep -q "x86_64 arm64"; then
    echo "❌ Main app is NOT a universal binary"
    ((issues++))
fi

# Check x3f_extract
if [ -f "$APP_PATH/Contents/Resources/x3f_extract" ]; then
    if ! lipo -info "$APP_PATH/Contents/Resources/x3f_extract" 2>&1 | grep -q "x86_64 arm64"; then
        echo "⚠️  x3f_extract is NOT a universal binary"
        ((issues++))
    fi
fi

if [ $issues -eq 0 ]; then
    echo "✅ All checks passed! The app should work on both Intel and Apple Silicon Macs."
else
    echo ""
    echo "⚠️  Found $issues issue(s) that may prevent the app from working on some Macs."
    echo ""
    echo "To fix:"
    echo "1. Ensure Xcode project has ARCHS = \$(ARCHS_STANDARD)"
    echo "2. Build with: xcodebuild ARCHS=\"x86_64 arm64\" ONLY_ACTIVE_ARCH=NO"
    echo "3. Verify embedded binaries are universal"
fi

echo ""
echo "================================================"
