Host libAMSKit.so (7.0.1 APK build) in OpenJDK on Linux via hybris. Build steps: dex2jar the APK, patch class
versions to 52, extract lib/x86_64 from the same APK, `make -C bridge`, javac java/adam. See memory note amskit-jvm-bridge.
