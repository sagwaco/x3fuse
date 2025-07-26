//
//  x3f_convertApp.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import SwiftUI

@main
struct x3f_convertApp: App {
    @StateObject private var updaterService = UpdaterService.shared
    
    init() {
        // Configure Sparkle on app launch
        Task { @MainActor in
            UpdaterService.shared.configureSparkle()
        }
    }
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(updaterService)
        }
        .commands {
            MenuCommands()
        }
        .windowResizability(.contentSize)
    }
}
