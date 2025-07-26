# X3Fuse

A modern macOS app for converting Sigma Merrill and Quattro X3F RAW files.

## Overview

X3Fuse is a RAW conversion tool that converts your Sigma Merrill and Quattro X3F files into practical, compatible formats like DNG, TIFF, and JPEG. It's an essential bridge between your Sigma cameras and your preferred editing suite.

## Features

- **Multiple Output Formats**: Convert X3F files to DNG, TIFF, or JPEG formats
- **Batch Processing**: Process multiple files at once with an intuitive queue system
- **Native macOS App**: Built with SwiftUI for a seamless macOS experience
- **EXIF Data Preservation**: Maintains metadata during conversion
- **Multi-language Support**: Available in English, Japanese, and Korean
- **Drag & Drop Interface**: Simple file management with drag and drop support
- **Conversion Settings**: Customizable output options for your workflow

## Supported Cameras

X3Fuse supports X3F files from Sigma cameras including:

- Sigma Merrill series cameras
- Sigma Quattro series cameras

## System Requirements

- macOS 14.0 (Sonoma) or later
- Apple Silicon (M1, M2, etc)

## Installation

### Option 1: Download Release

1. Download the latest release from the [Releases](https://github.com/sagwaco/x3fuse/releases) page
2. Launch the installer and follow the instructions

### Option 2: Build from Source

1. Clone the repository:
   ```bash
   git clone https://github.com/sagwaco/x3fuse.git
   cd x3fuse
   ```
2. Open `X3Fuse.xcodeproj` in Xcode
3. Build and run the project (⌘+R)

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

## Technical Details

X3Fuse leverages:

- **x3f_tools**: Core X3F file processing engine
- **ExifTool**: Comprehensive metadata handling
- **SwiftUI**: Modern native macOS interface
- **Opcode Libraries**: Camera-specific processing profiles

## Acknowledgements

Thank you to the kalpanika team for x3f_tools https://github.com/Kalpanika/x3f:

- Roland Karlsson (roland@proxel.se)
- Erik Karlsson (erik.r.karlsson@gmail.com)
- Mark Roden (mmroden@gmail.com) - [anisotropic filtering parts]

## License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you encounter any issues or have questions:

- Open an issue on [GitHub Issues](https://github.com/sagwaco/x3fuse/issues)
- Check the [Releases](https://github.com/sagwaco/x3fuse/releases) page for updates

## Privacy

X3Fuse processes all files locally on your Mac. No data is sent to external servers.
