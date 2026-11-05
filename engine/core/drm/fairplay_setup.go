package drm

import (
	"fmt"
	"strings"
	"unicode"
)

// SetupErrorPrefix starts the message of every sign-in failure that is about this
// installation (missing libraries) rather than the account. The app keeps a saved
// password through such a failure, because retrying with it later can work.
const SetupErrorPrefix = "FairPlay setup: "

func setupError(format string, a ...any) error {
	return fmt.Errorf(SetupErrorPrefix+format, a...)
}

// IsSetupError reports whether err is an installation problem (see SetupErrorPrefix).
func IsSetupError(err error) bool {
	return err != nil && strings.Contains(err.Error(), SetupErrorPrefix)
}

// verificationDigits keeps only the digits of a typed verification code, so "123 456",
// "123-456" and a pasted code with a trailing newline all reach Apple as "123456".
func verificationDigits(code string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsDigit(r) {
			return r
		}
		return -1
	}, code)
}
