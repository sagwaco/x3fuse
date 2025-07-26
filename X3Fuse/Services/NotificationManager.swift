//
//  NotificationManager.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import AppKit
import Foundation
import UserNotifications

class NotificationManager {
    static let shared = NotificationManager()
    
    private let logger = LoggingService.shared
    private let queue = ConversionQueue.shared
    
    private init() {}
    
    // MARK: - Completion Notification
    
    func showCompletionNotification() async {
        // Play positive completion chime
        playCompletionSound()
        
        // Request notification permission and show notification
        await showSystemNotification()
        
        logger.logConversion("Conversion batch completed: \(queue.getConversionSummary())")
    }
    
    // MARK: - Sound Notification
    
    private func playCompletionSound() {
        if let sound = NSSound(named: "Glass") {
            sound.play()
        } else {
            // Fallback to system beep if Glass sound is not available
            NSSound.beep()
        }
    }
    
    // MARK: - System Notification
    
    private func showSystemNotification() async {
        let center = UNUserNotificationCenter.current()
        
        // Request permission first
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound])
            
            if granted {
                // Create notification content
                let content = UNMutableNotificationContent()
                content.title = "X3F Conversion Complete"
                content.body = queue.getConversionSummary()
                content.sound = UNNotificationSound.default
                
                // Create notification request
                let request = UNNotificationRequest(
                    identifier: "conversion-complete",
                    content: content,
                    trigger: nil // Show immediately
                )
                
                // Schedule the notification
                try await center.add(request)
            }
        } catch {
            logger.logError("Failed to show completion notification: \(error)")
        }
    }
    
    // MARK: - Error Notification
    
    func showErrorNotification(title: String, message: String) async {
        let center = UNUserNotificationCenter.current()
        
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound])
            
            if granted {
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = message
                content.sound = UNNotificationSound.default
                
                let request = UNNotificationRequest(
                    identifier: "conversion-error-\(UUID().uuidString)",
                    content: content,
                    trigger: nil
                )
                
                try await center.add(request)
            }
        } catch {
            logger.logError("Failed to show error notification: \(error)")
        }
    }
    
    // MARK: - Progress Notification
    
    func showProgressNotification(filesCompleted: Int, totalFiles: Int) async {
        // Only show progress notifications for larger batches
        guard totalFiles > 5 else { return }
        
        // Show notification at 25%, 50%, 75% completion
        let progressPercentage = Double(filesCompleted) / Double(totalFiles)
        let milestones: [Double] = [0.25, 0.5, 0.75]
        
        guard milestones.contains(where: { abs($0 - progressPercentage) < 0.01 }) else {
            return
        }
        
        let center = UNUserNotificationCenter.current()
        
        do {
            let granted = try await center.requestAuthorization(options: [.alert])
            
            if granted {
                let content = UNMutableNotificationContent()
                content.title = "X3F Conversion Progress"
                content.body = "Completed \(filesCompleted) of \(totalFiles) files (\(Int(progressPercentage * 100))%)"
                
                let request = UNNotificationRequest(
                    identifier: "conversion-progress-\(filesCompleted)",
                    content: content,
                    trigger: nil
                )
                
                try await center.add(request)
            }
        } catch {
            logger.logError("Failed to show progress notification: \(error)")
        }
    }
    
    // MARK: - Notification Management
    
    func clearAllNotifications() {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }
    
    func clearCompletionNotifications() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["conversion-complete"])
        center.removeDeliveredNotifications(withIdentifiers: ["conversion-complete"])
    }
    
    // MARK: - Permission Management
    
    func requestNotificationPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            return granted
        } catch {
            logger.logError("Failed to request notification permission: \(error)")
            return false
        }
    }
    
    func checkNotificationPermission() async -> UNAuthorizationStatus {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        return settings.authorizationStatus
    }
}
