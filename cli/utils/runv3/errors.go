package runv3

import "errors"

// ErrNoSencBox is the sentinel for fragments that have no senc box (i.e.
// the fragment is not encrypted).  The mp4ff library returns this condition
// as a plain string error, so we cannot use errors.Is against the library
// value directly — instead, isNoSencBox compares by message so the string
// literal lives in exactly one place.
var ErrNoSencBox = errors.New("no senc box in traf")

// isNoSencBox reports whether err signals an unencrypted fragment.
func isNoSencBox(err error) bool {
	return err != nil && (errors.Is(err, ErrNoSencBox) || err.Error() == ErrNoSencBox.Error())
}
