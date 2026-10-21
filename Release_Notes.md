# 0.2.0 - Cross-platform RAW editor

- Replace the SwiftUI app with the new cross-platform X3Fuse app. macOS 14 or newer remains supported on Intel and Apple Silicon.
- Reset settings once when moving from the previous macOS app. Select your output directory, format, and denoise preferences again.
- Add a RAW editor with light, white balance, curves, HSL, crop, denoise, and sharpening controls, plus rendered JPEG and 16-bit TIFF export.
- Add Full spectrum editing with raw channel gains, a channel mixer, and swaps, plus an experimental Aerochrome-style look tuned on DP2 Merrill captures through a 550/660/850 nm filter. Use the neutral picker on a sunlit cloud.
- The RAW editor's film simulation uses the spektrafilm model by Andrea Volpato (https://github.com/andreavolpato/spektrafilm, profiles and data CC BY-SA 4.0), ported from spektrafilm-rs (GPL-3.0). It replaces the previous film model.
- Existing saved film edits load unchanged, but render differently with the new model. The recipe format is unchanged; no re-save is required.
- Add photo culling with pick/reject flags, star ratings, and queue filters.
- Reorganize the menus, with new View and Photo menus and File > Add Folder, and show most menu text in the app language. Add right-click menus to photos, the editor preview, and the editor sections. Help > Keyboard Shortcuts lists the keyboard shortcuts.
- Change two shortcuts to match other Mac photo apps: ⌘R now shows the selected photo in Finder, and ⌘. (Command-Period) stops an export. Export All no longer has a shortcut.
- Make Windows and Linux portable alpha builds available from the Releases page.
- Add Spanish to the cross-platform app, alongside English, Japanese, Korean, Simplified Chinese, and Traditional Chinese.
- Open Settings -> About -> View Licenses to read the bundled third-party notices.

# 0.1.9 - Beta 1.1.9

- Update the converter to x3fuse-core 0.3.0. Default Merrill TIFF rendering now uses calibration, color, and tone corrections derived from Sigma Photo Pro, so TIFF output can differ from earlier releases. TIFFs now embed ICC profiles for sRGB, Adobe RGB, and ProPhoto RGB and record the camera orientation.
- Add an experimental Color mode setting for DNG and TIFF that applies Sigma camera color modes, or the mode recorded in the file, to Merrill and dp Quattro files. DNGs include the modes as selectable camera profiles. Other cameras convert without a color mode.
- Add a Sigma Photo Pro processing option for full-resolution Merrill TIFFs that uses Sigma Photo Pro highlight recovery, noise reduction, and sharpening.
- Add a Highlight recovery setting for TIFF output. Turn it off to use the earlier basic recovery.
- Fix conversions failing when the None color profile is selected.

# 0.1.8 - Beta 1.1.8

- Update the converter to x3fuse-core 0.2.1 and add DNG and TIFF conversion for Sigma SD9, SD10, and SD14 files. SD9 and SD10 files have no embedded JPEG preview to extract.
- Add NLM and BM3D denoise controls, separate luminance and color noise settings, strength and NLM window controls, and automatic, CPU, or GPU processing.
- Update default NLM processing to reduce color noise with luminance noise reduction off. Existing intensity settings are retained; denoised output can differ from earlier releases.
- Fix large conversion batches exhausting the file limit by closing subprocess pipe descriptors after use.
- Leave unavailable camera metadata unset instead of substituting Merrill camera details when metadata extraction fails.

# 0.1.7 - Beta 1.1.7

- Fix the primary Convert button processing only one file after adding multiple files; it now converts the entire queue.
- Fix reconversion confirmation skipping requested files that do not already have output.
- Reject truncated or corrupt X3F files before conversion so they cannot stall the queue, and continue processing the remaining files.

# 0.1.6 - Beta 1.1.6

- Update the core converter to x3fuse-core 0.1.4.
- Improve Quattro and Merrill DNG compatibility and color calibration in Apple RAW, Adobe Camera Raw, and LibRaw.
- Improve color highlight recovery.

# 0.1.5 - Beta 1.1.5

- Update the core converter to x3fuse-core 0.1.2, improving compatibility of converted DNGs (including compressed DNGs) with software powered by Apple RAW and LibRaw, and improving Capture One compatibility for Merrill-generation files.
- Fix highlights clipping prematurely near white on some files, caused by DigitalISOGain scaling during preprocessing.
- Add Spanish (es) localization.
- Fix the denoise slider labels in Settings showing raw localization keys instead of translated text.
- The in-app update prompt now displays release notes, so you can see what changed before updating.

# 0.1.4 - Beta 1.1.4

- The app is now notarized by Apple, so it launches without Gatekeeper warnings, and is installable via Homebrew with `brew install --cask sagwaco/tap/x3fuse`. No functional changes from 0.1.3.
- Packaging-only release; see 0.1.3 for the latest features.

# 0.1.3 - Beta 1.1.3

- Add a denoise slider to control denoising intensity. The maximum value matches the previous default, the minimum is 1, and denoising can be toggled off entirely to disable it.

# 0.1.2 - Beta 1.1.2

- Add highlight recovery option for Merrill DNGs, which prevents string hue shifts in extremely overexposed areas. This setting has only been tested to work with Adobe Camera RAW and LibRaw.
- Add option to apply a flat cineon-like tone curve to tiffs.

# 0.1.1 - Beta 1.1.1

- Make RAW compression warning message easier on the eyes
- Actually supports Intel Macs now...

# 0.1.0 - Beta 1.1.0

- Support Intel Macs. Intel and Apple Silicon macs on macOS 14+ are now supported.
- Apply DPXM green cast fixes to the SD1M
- Add warning message for RAW compression

# 0.0.6 - Beta 1.0.6

- Fix purple tint issue on low ISO SD Quattro H images

# 0.0.5 - Beta 1.0.3

- Improved settings UI
- Add Chinese localizations

# 0.0.4 - Beta 1.0.2

- Test version bump

# 0.0.3 - Beta 1.0.1

- Test version bump

# 0.0.2 - Beta 1

- Update x3f_extract entitlements

# 0.0.1 - Initial Release

- Initial release of X3Fuse
- Convert Sigma X3F files to DNG format
- Support for multiple Sigma camera models (DPXM, DPXQ)
- Drag and drop interface for easy file processing
- Batch conversion capabilities
- Localization support for English, Korean, and Japanese
- Automatic opcode application for lens corrections
