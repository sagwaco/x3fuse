# X3Fuse

A macOS app for converting Sigma classic, Merrill, and Quattro X3F RAW files.

![X3Fuse logo and app screeenshot](app-screenshot.png)

## Overview

X3Fuse converts Sigma X3F files to DNG and TIFF and extracts embedded JPEG previews when available. Supported cameras include the classic SD9, SD10, and SD14, plus the Merrill and Quattro generations. You can use the converted files in editors that support these formats.

## Features

- **Multiple Output Formats**: Convert X3F files to DNG, TIFF, or JPEG formats
- **Batch Processing**: Process multiple files at once with an intuitive queue system
- **Native macOS App**: Built with SwiftUI for a seamless macOS experience
- **EXIF Data Preservation**: Attempts to preserve metadata like preferred aspect ratio
- **Broad DNG Compatibility**: Merrill and Quattro DNGs are tested with Adobe, LibRaw, and Apple RAW-based workflows
- **Multi-language Support**: Available in English, Spanish, Japanese, Korean, and Chinese\*
- **Drag & Drop Interface**: Simple file management with drag and drop support
- **Conversion Settings**: Customizable output options for your workflow

<sub>\*Don't see your language? Help us translate! See [Contributing](#contributing) below.</sub>

## Supported Cameras

X3Fuse supports X3F files from the following Sigma cameras.

| Camera Model           | Tested | Notes    |
| ---------------------- | ------ | -------- |
| **Classic Generation** |        |          |
| Sigma SD9              | ✅     | DNG and TIFF; no embedded JPEG |
| Sigma SD10             | ✅     | DNG and TIFF; no embedded JPEG |
| Sigma SD14             | ✅     | DNG, TIFF, and embedded JPEG |
| **Merrill Generation** |        |          |
| Sigma DP1 Merrill      | ✅     |          |
| Sigma DP2 Merrill      | ✅     |          |
| Sigma DP3 Merrill      | ✅     |          |
| Sigma SD1 Merrill      | ✅     |          |
| **Quattro Generation** |        |          |
| Sigma DP0 Quattro      | ✅     |          |
| Sigma DP1 Quattro      | ✅     |          |
| Sigma DP2 Quattro      | ✅     |          |
| Sigma DP3 Quattro      | ✅     |          |
| Sigma SD Quattro       | ✅     |          |
| Sigma SD Quattro H     | ✅     |          |

Classic-camera checks use one public sample per model from [raw.pixls.us](https://raw.pixls.us/).
They verify conversion and metadata, not every camera setting or editor. Other classic bodies
are not yet tested. If your camera is not listed, please open an issue with a sample X3F.

## System Requirements

- macOS 14.0 (Sonoma) or later
- Intel or Apple Silicon

## Installation

### Option 1: Download Release

1. Download the latest .zip from the [Releases](https://github.com/sagwaco/x3fuse/releases) page
2. Extract the .zip file and move the `X3Fuse.app` to your Applications folder.
3. Launch `X3Fuse.app` from your Applications folder.


### Option 2: Homebrew

```bash
brew install --cask sagwaco/tap/x3fuse
```

Upgrade later with `brew upgrade --cask x3fuse` (the app also self-updates in-app via Sparkle).

### Option 3: Build from Source

1. Clone the repository:
   ```bash
   git clone --recurse-submodules https://github.com/sagwaco/x3fuse.git
   cd x3fuse
   ```
2. Open `X3Fuse.xcodeproj` in Xcode
3. Build and run the project (⌘+R)

ExifTool **13.33** is pinned to an upstream commit in the `Vendor/ExifTool` Git
submodule. Xcode copies its `exiftool` script and `lib` directory into the app.
Users do not need to install ExifTool separately. Its license is included in
`X3Fuse/Acknowledgements.txt`.

For an existing clone or a new worktree, run this command before building:

```bash
git submodule update --init --recursive
```

This downloads the pinned dependency once. Later builds use the local copy.
Run the same command after pulling a change to the submodule pin. To update
ExifTool, check out the required release tag in `Vendor/ExifTool`, then commit
the submodule pointer. Update the version in `README.md`, `AGENTS.md`, and
`X3FuseTests/ExifToolBundleTests.swift` in the same commit.

The app bundles [x3fuse-core **0.3.0**](https://github.com/sagwaco/x3fuse-core/releases/tag/v0.3.0)
(commit `0df46ff733b345bdb4186bc7433619e3b0b05ae5`). This release updates default Merrill
TIFF rendering, embeds ICC profiles in sRGB, Adobe RGB, and ProPhoto RGB TIFFs,
and records camera orientation.
The universal converter combines the release's Intel and Apple Silicon binaries, with
GPU denoising enabled.
To rebuild from source, use a clean core checkout at `v0.3.0`, then run this command
from the X3Fuse app repository:

```bash
X3FUSE_CORE=/path/to/x3fuse-core ./scripts/build_x3f_extract.sh
```

## Scripts

### verify_universal_build.sh

```bash
./scripts/verify_universal_build.sh
```

This script verifies that the app and its components are properly built as universal binaries. It checks the architecture of the main app executable and any embedded binaries, ensuring they support both Intel and Apple Silicon architectures.

## Usage

1. **Launch X3Fuse** from your Applications folder

2. **Add Files**:
   - Drag and drop X3F files onto the app window
   - Or use File → Open to browse for files

3. **Configure Settings**:
   - Choose your output format (DNG, TIFF, or JPEG)
   - Set output directory preferences
   - Adjust conversion options as needed

4. **Convert**:
   - Click the Convert button to start processing
   - Monitor progress in the queue view
   - Converted files will be saved to your specified location

For DNG and TIFF, Settings provides NLM and BM3D denoising, separate luminance and color
noise controls, and the existing intensity slider. Advanced denoise settings provide a
strength multiplier, NLM patch and search sizes in pixels, and Automatic, CPU, or GPU
processing. Automatic uses the GPU when available and falls back to the CPU. Forced GPU
processing stops conversion if acceleration is unavailable. BM3D ignores NLM window sizes
and can take longer than NLM.

Existing intensity preferences are retained. New settings use the core defaults: NLM,
color noise reduction on, luminance noise reduction off, strength 1.0, patch size 3,
search size 11, and Automatic processing. Core 0.2.0 changes the default NLM luminance
handling, so denoised output can differ from previous versions.

Core 0.3.0 adds these settings:

- **Color mode (experimental)**, for DNG and RGB TIFF: applies a Sigma camera color mode,
  or the mode recorded in the file, to Merrill and dp Quattro files. Sunset Red,
  Forest Green, FOV Classic Yellow, Cinema, and Teal and Orange are dp Quattro only.
  TIFF applies the look to the pixels. DNG keeps the RAW data and embeds the modes as
  selectable camera profiles. Other cameras convert without a color mode.
- **Sigma Photo Pro processing (Merrill)**, for RGB TIFF: uses the SPP highlight recovery,
  noise reduction, and sharpening on full-resolution (HI) Merrill files. It runs on the CPU
  and replaces the denoise settings. Other cameras use the standard processing.
- **Highlight recovery**, for RGB TIFF: on by default. Turn it off to use the earlier basic
  recovery instead of the scene-derived color table.

Cineon TIFF and TIFF without a color profile do not use these settings.

### Converting a classic-camera library

Keep the original X3F files as your archive. A DNG contains converted image data, not a
complete copy of the X3F. Conversion applies camera calibration and any selected noise
reduction. You cannot undo these steps in the DNG or recover all Sigma Photo Pro settings.

| Goal | Output and settings |
| ---- | ------------------- |
| Continue editing exposure and white balance | DNG. Enable RAW compression to reduce its size. |
| Apply noise reduction in the destination editor | DNG with Denoise intensity set to Off. |
| Apply X3Fuse noise reduction during conversion | DNG or TIFF. Start with the defaults and compare a few images at full size. |
| Save a rendered image for editors without DNG support | 16-bit TIFF. Choose a color profile and enable compression if the editor supports it. |
| Extract the camera preview | Embedded JPG, when present. SD9 and SD10 files have no embedded JPEG. |

DNG uses lossless compression of the converted pixels. It does not make the conversion
reversible or guarantee a file smaller than the X3F. TIFF also supports lossless compression,
but stores rendered RGB data and can be much larger. Embedded JPG extracts an existing
preview; it does not render a new JPEG with your conversion settings.

These sample sizes use default noise reduction on the CPU, before the app copies additional
EXIF tags. Sizes are rounded decimal MB. Results depend on the image and settings.

| Sample | Original X3F | DNG | Compressed DNG |
| ------ | -----------: | --: | -------------: |
| [SD9](https://raw.pixls.us/getfile.php/700/nice/Sigma%20-%20Sigma%20SD9.X3F) | 7.4 MB | 20.7 MB | 12.5 MB |
| [SD10](https://raw.pixls.us/getfile.php/571/nice/Sigma%20-%20Sigma%20SD10.X3F) | 8.1 MB | 20.7 MB | 14.0 MB |
| [SD14](https://raw.pixls.us/getfile.php/4462/nice/Sigma%20-%20SIGMA%20SD14%20-%203:2.X3F) | 12.2 MB | 28.1 MB | 17.6 MB |

Noise reduction is saved in the output pixels. Stronger settings can remove fine detail.
For future noise-reduction work, retain the X3F and compare an undenoised DNG with a denoised
copy. X3Fuse uses its own NLM or BM3D processing; it does not reproduce Sigma Photo Pro's
noise reduction or saved edits. Leave Merrill highlight recovery off when starting with
classic files. No classic-camera flat-field opcode files are bundled.

Convert a small batch first. Check color, highlights, fine detail, metadata, and file size in
your destination editor before converting the library. The editor compatibility results
below apply to Merrill and Quattro files; classic DNGs still need checks in each editor.

## DNG Compatibility

X3Fuse creates DNGs that are designed to work across common RAW decoding engines, not only Adobe Camera Raw. Merrill and Quattro files, including DNGs created with **RAW compression** and/or **Merrill highlight recovery** enabled, have been tested successfully in:

- Adobe Lightroom and Adobe Photoshop
- Darktable
- RawTherapee
- RapidRAW
- Pixelmator and Photomator
- Preview on macOS

Foveon cameras do not have a color filter array (CFA) like most other cameras, so some RAW applications may still have Foveon-specific rendering differences. If you encounter an issue with a particular editor, please open a GitHub issue with the camera model, conversion settings, and target application.

## Known Issues

#### X3I files not supported

X3I files generated in Quattro Super fine detail (SFD) mode are not supported. A workaround is to shoot several exposure bracketed images as X3Fs and then use X3Fuse to convert them to DNG. In a photo editing application like Lightroom, you can then merge the DNG files into an HDR image.

## Technical Details

X3Fuse leverages:

- [**x3fuse-core**](https://github.com/sagwaco/x3fuse-core): Core X3F file processing engine
- [**ExifTool**](https://github.com/exiftool/exiftool): EXIF Metadata handling

## Acknowledgements

[x3fuse-core](https://github.com/sagwaco/x3fuse-core), which powers the x3f processing in x3fuse is based on [x3f_tools](https://github.com/Kalpanika/x3f). This project is not affiliated with nor endorsed by the creators of x3f_tools.

## License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

This project is not affiliated nor endorsed by Sigma Corporation. Sigma and Foveon are trademarks of Sigma Corporation.

## Contributing

Contributions are welcome! Please feel free to submit a [Pull Request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request).

## Support

If you encounter any issues or have questions:

- Open an issue on [GitHub Issues](https://github.com/sagwaco/x3fuse/issues)
- Check the [Releases](https://github.com/sagwaco/x3fuse/releases) page for updates

## Privacy

X3Fuse processes all files locally on your Mac. No data is sent to external servers.
