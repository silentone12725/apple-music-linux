# Apple Music Linux Client

A native-feeling Linux desktop client for Apple Music built with Go and the [Wails](https://wails.io) framework.

## Features

- **Frameless Window**: Blends seamlessly into Linux desktop environments using the native WebKit2GTK renderer.
- **Glassmorphism Support**: GPU hardware acceleration enabled by default for beautiful UI blurring.
- **Dynamic CSS Injection**: Automatically eradicates "Open in App" upsell banners and buttons from the live Apple Music DOM.
- **CLI Hardware Acceleration**: The underlying CLI (`apple-music-cli`) utilizes `ffmpeg` and `mpv` for media processing and playback. Hardware decoding (`-hwaccel auto` and `--hwdec=auto`) is strictly enabled in the CLI to offload processing to the GPU. This minimizes CPU usage, prevents stuttering during high-res lossless streaming, and reduces battery drain.

## Development

To run the application in live development mode (which provides hot-reloading for both Go and frontend changes):

```bash
# On Ubuntu 24.04 / Zorin OS 18, you must install the WebKit 4.1 dev libraries:
# sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev build-essential pkg-config

# Run with the webkit2_41 tag
wails dev -tags webkit2_41
```

## Building

To build a standalone executable for production:

```bash
wails build -tags webkit2_41
```

The compiled binary will be placed in `build/bin/`.
