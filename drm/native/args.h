/*
 * args.h — the few settings the wrapper reads from the host. drm_lib_init() fills them in from the config the Go engine
 * passes; they used to be parsed from a command line (gengetopt), which the library never uses.
 */
#pragma once

struct adam_args {
    char *base_dir_arg;    /* session directory (mpl_db, MUSIC_TOKEN, STOREFRONT_ID, ...) */
    char *device_info_arg; /* ClientIdentifier/Version/Platform/ProductVersion/DeviceModel/Build/Locale/Language/AndroidID */
};
