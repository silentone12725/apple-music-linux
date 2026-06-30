//go:build linux && !webkit2_41

package main

/*
#cgo pkg-config: webkit2gtk-4.0
#include <webkit2/webkit2.h>
#include <stdlib.h>

void patch_cookie_storage(const char *path) {
    WebKitWebContext *ctx = webkit_web_context_get_default();
    WebKitCookieManager *cm = webkit_web_context_get_cookie_manager(ctx);
    webkit_cookie_manager_set_persistent_storage(
        cm,
        path,
        WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE
    );
}
*/
import "C"
import (
	"log"
	"os"
	"path/filepath"
	"unsafe"
)

func patchCookieStorage() {
	configDir, err := os.UserConfigDir()
	if err != nil {
		log.Println("[WebKitGTK] Failed to get config dir for cookie storage:", err)
		return
	}
	
	cookieDir := filepath.Join(configDir, "apple-music-linux", "webview-data")
	os.MkdirAll(cookieDir, 0700)
	
	cookiePath := filepath.Join(cookieDir, "cookies.sqlite")
	cPath := C.CString(cookiePath)
	defer C.free(unsafe.Pointer(cPath))
	
	C.patch_cookie_storage(cPath)
	log.Println("[WebKitGTK] Enabled persistent cookie storage at:", cookiePath)
}
