package drm

// nativeAuthChallenge translates the C callback protocol into frontend prompts.
func nativeAuthChallenge(kind string) (AuthChallenge, bool) {
	switch kind {
	case "credentials":
		return AuthChallenge{Type: ChallengeCredentials, Title: "Sign in to Apple Music"}, true
	case "2fa":
		return AuthChallenge{Type: ChallengeTwoFactor, Title: "Apple ID verification code", Description: "Enter the six-digit code sent to your trusted Apple device."}, true
	case "device_approval":
		return AuthChallenge{Type: ChallengeDeviceApproval, Title: "Approve sign-in on your Apple device"}, true
	default:
		return AuthChallenge{}, false
	}
}
