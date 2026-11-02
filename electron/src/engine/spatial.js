// The native audio route is required for EC-3. This preference requests a
// stream format only; it says nothing about JOC decoding or HDMI passthrough.
export function wantsAtmos(preference, losslessRoute, isVideo = false) {
    return preference === 'atmos' && losslessRoute === true && !isVideo;
}
