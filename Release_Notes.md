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
