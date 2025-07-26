//
//  LocalizationService.swift
//  X3Fuse
//
//  Created by Cline on 7/18/25.
//

import Foundation
import SwiftUI

/// Service for managing localized strings throughout the app
struct LocalizationService {
    
    // MARK: - App Title
    static let appTitle = NSLocalizedString("app.title", comment: "App title")
    
    // MARK: - Buttons
    static let buttonConvert = NSLocalizedString("button.convert", comment: "Convert button")
    static let buttonStop = NSLocalizedString("button.stop", comment: "Stop button")
    static let buttonAddFiles = NSLocalizedString("button.add_files", comment: "Add files button")
    static let buttonSettings = NSLocalizedString("button.settings", comment: "Settings button")
    static let buttonOK = NSLocalizedString("button.ok", comment: "OK button")
    static let buttonCancel = NSLocalizedString("button.cancel", comment: "Cancel button")
    static let buttonDone = NSLocalizedString("button.done", comment: "Done button")
    static let buttonBrowse = NSLocalizedString("button.browse", comment: "Browse button")
    static let buttonOverwrite = NSLocalizedString("button.overwrite", comment: "Overwrite button")
    
    // MARK: - Toolbar and Menu
    static let toolbarStopConversion = NSLocalizedString("toolbar.stop_conversion", comment: "Stop conversion tooltip")
    static let toolbarConvertAll = NSLocalizedString("toolbar.convert_all", comment: "Convert all tooltip")
    static let toolbarConvertSelected = NSLocalizedString("toolbar.convert_selected", comment: "Convert selected tooltip")
    
    // MARK: - Footer
    static let footerOutputDirectory = NSLocalizedString("footer.output_directory", comment: "Output directory label")
    static let footerAlongsideOriginal = NSLocalizedString("footer.alongside_original", comment: "Alongside original file text")
    
    // MARK: - File Selection Dialog
    static let dialogSelectX3FFilesTitle = NSLocalizedString("dialog.select_x3f_files.title", comment: "Select X3F files dialog title")
    static let dialogSelectX3FFilesMessage = NSLocalizedString("dialog.select_x3f_files.message", comment: "Select X3F files dialog message")
    static let dialogSelectOutputDirectoryTitle = NSLocalizedString("dialog.select_output_directory.title", comment: "Select output directory dialog title")
    static let dialogSelectOutputDirectoryMessage = NSLocalizedString("dialog.select_output_directory.message", comment: "Select output directory dialog message")
    
    // MARK: - Alerts
    static let alertSetupIssuesTitle = NSLocalizedString("alert.setup_issues.title", comment: "Setup issues alert title")
    
    // MARK: - Settings View
    static let settingsSectionOutput = NSLocalizedString("settings.section.output", comment: "Output settings section")
    static let settingsSectionConversion = NSLocalizedString("settings.section.conversion", comment: "Conversion settings section")
    static let settingsSectionDebug = NSLocalizedString("settings.section.debug", comment: "Debug settings section")
    static let settingsSectionUpdates = NSLocalizedString("settings.section.updates", comment: "Updates settings section")
    static let settingsSectionAbout = NSLocalizedString("settings.section.about", comment: "About settings section")
    
    static let settingsSaveAlongsideOriginal = NSLocalizedString("settings.save_alongside_original", comment: "Save alongside original setting")
    static let settingsSaveAlongsideOriginalHelp = NSLocalizedString("settings.save_alongside_original.help", comment: "Save alongside original help text")
    static let settingsSaveAlongsideOriginalDescription = NSLocalizedString("settings.save_alongside_original.description", comment: "Save alongside original description")
    
    static let settingsOutputLocation = NSLocalizedString("settings.output_location", comment: "Output location setting")
    static let settingsOnlyConvertNew = NSLocalizedString("settings.only_convert_new", comment: "Only convert new items setting")
    static let settingsOnlyConvertNewHelp = NSLocalizedString("settings.only_convert_new.help", comment: "Only convert new items help text")
    
    static let settingsConversionFormat = NSLocalizedString("settings.conversion_format", comment: "Conversion format setting")
    static let settingsRawCompression = NSLocalizedString("settings.raw_compression", comment: "RAW compression setting")
    static let settingsRawCompressionHelp = NSLocalizedString("settings.raw_compression.help", comment: "RAW compression help text")
    static let settingsColorProfile = NSLocalizedString("settings.color_profile", comment: "Color profile setting")
    static let settingsDenoise = NSLocalizedString("settings.denoise", comment: "Denoise setting")
    static let settingsDenoiseHelp = NSLocalizedString("settings.denoise.help", comment: "Denoise help text")
    static let settingsFasterProcessing = NSLocalizedString("settings.faster_processing", comment: "Faster processing setting")
    static let settingsFasterProcessingHelp = NSLocalizedString("settings.faster_processing.help", comment: "Faster processing help text")
    
    static let settingsDebugLogging = NSLocalizedString("settings.debug_logging", comment: "Debug logging setting")
    static let settingsDebugLoggingHelp = NSLocalizedString("settings.debug_logging.help", comment: "Debug logging help text")
    static let settingsDebugLogs = NSLocalizedString("settings.debug_logs", comment: "Debug logs label")
    static let settingsOpenLogsFolder = NSLocalizedString("settings.open_logs_folder", comment: "Open logs folder button")
    static let settingsClearLogs = NSLocalizedString("settings.clear_logs", comment: "Clear logs button")
    
    static let settingsLogConversion = NSLocalizedString("settings.log.conversion", comment: "Conversion log label")
    static let settingsLogError = NSLocalizedString("settings.log.error", comment: "Error log label")
    static let settingsLogDebug = NSLocalizedString("settings.log.debug", comment: "Debug log label")
    
    static let settingsVersion = NSLocalizedString("settings.version", comment: "Version label")
    static let settingsBuild = NSLocalizedString("settings.build", comment: "Build label")
    
    // MARK: - Menu Commands
    static let menuHelpX3FuseHelp = NSLocalizedString("menu.help.X3Fuse_help", comment: "X3Fuse help menu item")
    static let menuHelpShowDebugLogs = NSLocalizedString("menu.help.show_debug_logs", comment: "Show debug logs menu item")
    static let menuHelpClearDebugLogs = NSLocalizedString("menu.help.clear_debug_logs", comment: "Clear debug logs menu item")
    
    static let menuFileAddX3FFiles = NSLocalizedString("menu.file.add_x3f_files", comment: "Add X3F files menu item")
    static let menuFileSettings = NSLocalizedString("menu.file.settings", comment: "Settings menu item")
    
    static let menuEditSelectAllFiles = NSLocalizedString("menu.edit.select_all_files", comment: "Select all files menu item")
    static let menuEditDeselectAllFiles = NSLocalizedString("menu.edit.deselect_all_files", comment: "Deselect all files menu item")
    static let menuEditRemoveSelectedFiles = NSLocalizedString("menu.edit.remove_selected_files", comment: "Remove selected files menu item")
    
    static let menuConversionTitle = NSLocalizedString("menu.conversion.title", comment: "Conversion menu title")
    static let menuConversionConvertAllFiles = NSLocalizedString("menu.conversion.convert_all_files", comment: "Convert all files menu item")
    static let menuConversionStopConversion = NSLocalizedString("menu.conversion.stop_conversion", comment: "Stop conversion menu item")
    static let menuConversionClearQueue = NSLocalizedString("menu.conversion.clear_queue", comment: "Clear queue menu item")
    static let menuConversionRemoveFailedFiles = NSLocalizedString("menu.conversion.remove_failed_files", comment: "Remove failed files menu item")
    static let menuConversionRemoveCompletedFiles = NSLocalizedString("menu.conversion.remove_completed_files", comment: "Remove completed files menu item")
    
    // MARK: - File Queue View
    static let queueColumnName = NSLocalizedString("queue.column.name", comment: "Name column header")
    static let queueColumnDate = NSLocalizedString("queue.column.date", comment: "Date column header")
    static let queueColumnSize = NSLocalizedString("queue.column.size", comment: "Size column header")
    
    static let queueEmptyTitle = NSLocalizedString("queue.empty.title", comment: "Empty queue title")
    static let queueEmptyMessage = NSLocalizedString("queue.empty.message", comment: "Empty queue message")
    
    // MARK: - Context Menu
    static let contextConvert = NSLocalizedString("context.convert", comment: "Convert context menu item")
    static let contextConvertSelected = NSLocalizedString("context.convert_selected", comment: "Convert selected context menu item")
    static let contextReconvert = NSLocalizedString("context.reconvert", comment: "Re-convert context menu item")
    static let contextReconvertSelected = NSLocalizedString("context.reconvert_selected", comment: "Re-convert selected context menu item")
    static let contextStopConversion = NSLocalizedString("context.stop_conversion", comment: "Stop conversion context menu item")
    static let contextRemove = NSLocalizedString("context.remove", comment: "Remove context menu item")
    static let contextRemoveSelected = NSLocalizedString("context.remove_selected", comment: "Remove selected context menu item")
    static let contextShowInFinder = NSLocalizedString("context.show_in_finder", comment: "Show in Finder context menu item")
    static let contextOpenConvertedInFinder = NSLocalizedString("context.open_converted_in_finder", comment: "Show converted file in Finder context menu item")
    static let contextOpenConvertedInFinderMultiple = NSLocalizedString("context.open_converted_in_finder_multiple", comment: "Show converted files in Finder context menu item")
    static let contextRemoveFailedFile = NSLocalizedString("context.remove_failed_file", comment: "Remove failed file context menu item")
    static let contextRemoveFailedFiles = NSLocalizedString("context.remove_failed_files", comment: "Remove failed files context menu item")
    static let contextRemoveCompletedFile = NSLocalizedString("context.remove_completed_file", comment: "Remove completed file context menu item")
    static let contextRemoveCompletedFiles = NSLocalizedString("context.remove_completed_files", comment: "Remove completed files context menu item")
    static let contextDeselectAll = NSLocalizedString("context.deselect_all", comment: "Deselect all context menu item")
    static let contextConvertAll = NSLocalizedString("context.convert_all", comment: "Convert all context menu item")
    static let contextRemoveAll = NSLocalizedString("context.remove_all", comment: "Remove all context menu item")
    
    // MARK: - Reconversion Confirmation
    static let reconversionTitle = NSLocalizedString("reconversion.title", comment: "Reconversion dialog title")
    static let reconversionMessage = NSLocalizedString("reconversion.message", comment: "Reconversion dialog message")
    static let reconversionWarning = NSLocalizedString("reconversion.warning", comment: "Reconversion warning text")
    static let reconversionLocationPrefix = NSLocalizedString("reconversion.location_prefix", comment: "Reconversion location prefix")
    
    // MARK: - File Status
    static let statusQueued = NSLocalizedString("status.queued", comment: "Queued status")
    static let statusProcessing = NSLocalizedString("status.processing", comment: "Processing status")
    static let statusCompleted = NSLocalizedString("status.completed", comment: "Completed status")
    static let statusFailed = NSLocalizedString("status.failed", comment: "Failed status")
    static let statusWarning = NSLocalizedString("status.warning", comment: "Warning status")
    static let statusConversionFailed = NSLocalizedString("status.conversion_failed", comment: "Conversion failed message")
    static let statusConversionCompletedWithWarnings = NSLocalizedString("status.conversion_completed_with_warnings", comment: "Conversion completed with warnings message")
    
    // MARK: - Updates
    static let updatesCheckForUpdates = NSLocalizedString("updates.check_for_updates", comment: "Check for updates menu item")
    static let updatesCheckingForUpdates = NSLocalizedString("updates.checking_for_updates", comment: "Checking for updates text")
    static let updatesAutomaticUpdates = NSLocalizedString("updates.automatic_updates", comment: "Automatic updates setting")
    static let updatesAutomaticUpdatesHelp = NSLocalizedString("updates.automatic_updates.help", comment: "Automatic updates help text")
    static let updatesAutomaticDownload = NSLocalizedString("updates.automatic_download", comment: "Automatic download setting")
    static let updatesAutomaticDownloadHelp = NSLocalizedString("updates.automatic_download.help", comment: "Automatic download help text")
    static let updatesLastChecked = NSLocalizedString("updates.last_checked", comment: "Last checked for updates")
    static let updatesNever = NSLocalizedString("updates.never", comment: "Never checked for updates")
    static let updatesCurrentVersion = NSLocalizedString("updates.current_version", comment: "Current version label")
    
    // MARK: - Placeholders
    static let placeholderDash = NSLocalizedString("placeholder.dash", comment: "Dash placeholder")
}

// MARK: - SwiftUI Text Extensions
extension Text {
    init(localized key: String, comment: String = "") {
        self.init(NSLocalizedString(key, comment: comment))
    }
}
