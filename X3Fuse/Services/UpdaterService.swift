//
//  UpdaterService.swift
//  X3Fuse
//
//  Created by Cline on 7/19/25.
//

import SwiftUI
import Sparkle

/// Service for managing app updates using Sparkle
@MainActor
final class UpdaterService: ObservableObject {
    static let shared = UpdaterService()
    
    private let updaterController: SPUStandardUpdaterController
    
    @Published var canCheckForUpdates = false
    @Published var isCheckingForUpdates = false
    @Published var lastUpdateCheckDate: Date?
    
    private static let lastUpdateCheckDateKey = "X3Fuse.lastUpdateCheckDate"
    
    private init() {
        // Initialize Sparkle updater
        updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        
        // Load persisted last update check date
        loadLastUpdateCheckDate()
        
        setupUpdateObservers()
        updateCanCheckForUpdates()
    }
    
    // MARK: - Public Methods
    
    /// Check for updates manually
    func checkForUpdates() {
        guard canCheckForUpdates else { return }
        
        isCheckingForUpdates = true
        updaterController.checkForUpdates(nil)
    }
    
    /// Enable or disable automatic update checks
    func setAutomaticUpdateChecks(enabled: Bool) {
        updaterController.updater.automaticallyChecksForUpdates = enabled
    }
    
    /// Get the current automatic update check setting
    var automaticallyChecksForUpdates: Bool {
        updaterController.updater.automaticallyChecksForUpdates
    }
    
    /// Enable or disable automatic download of updates
    func setAutomaticDownload(enabled: Bool) {
        updaterController.updater.automaticallyDownloadsUpdates = enabled
    }
    
    /// Get the current automatic download setting
    var automaticallyDownloadsUpdates: Bool {
        updaterController.updater.automaticallyDownloadsUpdates
    }
    
    /// Get the current app version
    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
    }
    
    /// Get the current build number
    var currentBuildNumber: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
    }
    
    // MARK: - Private Methods
    
    private func loadLastUpdateCheckDate() {
        if let savedDate = UserDefaults.standard.object(forKey: Self.lastUpdateCheckDateKey) as? Date {
            lastUpdateCheckDate = savedDate
        }
    }
    
    private func saveLastUpdateCheckDate() {
        if let date = lastUpdateCheckDate {
            UserDefaults.standard.set(date, forKey: Self.lastUpdateCheckDateKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.lastUpdateCheckDateKey)
        }
    }
    
    private func setupUpdateObservers() {
        // Observer for when update check begins
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("SUUpdaterWillRestartNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.isCheckingForUpdates = false
            }
        }
        
        // Observer for when update check ends
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("SUUpdaterDidFinishLoadingAppCastNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.isCheckingForUpdates = false
                self?.lastUpdateCheckDate = Date()
                self?.saveLastUpdateCheckDate()
            }
        }
        
        // Update canCheckForUpdates when updater state changes
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateCanCheckForUpdates()
            }
        }
    }
    
    private func updateCanCheckForUpdates() {
        let newValue = updaterController.updater.canCheckForUpdates
        if canCheckForUpdates != newValue {
            canCheckForUpdates = newValue
        }
    }
}

// MARK: - Sparkle Configuration Extension
extension UpdaterService {
    
    /// Configure Sparkle with default settings for the app
    func configureSparkle() {
        // Set reasonable defaults
        setAutomaticUpdateChecks(enabled: true)
        setAutomaticDownload(enabled: false) // Let user choose to download
        
        // Set update check interval (24 hours)
        updaterController.updater.updateCheckInterval = 86400
    }
}
