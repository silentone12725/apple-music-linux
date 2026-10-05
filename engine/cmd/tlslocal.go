package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"time"
)

// loopbackTLSConfig returns a TLS config backed by a freshly generated,
// self-signed certificate valid for the loopback addresses. It exists so the
// engine can serve the video-dl endpoint over HTTPS on 127.0.0.1 — Chrome's
// <video src> refuses plain http:// on an https:// page (mixed content), but a
// real HTTPS origin lets it use its native, reliable byte-range seeking instead
// of the buggy custom-protocol path. The Electron side trusts this cert for
// 127.0.0.1 via session.setCertificateVerifyProc.
//
// Improvements over previous implementation:
// - TLS 1.3 support (preferred) with TLS 1.2 fallback
// - Strong cipher suites only (AES-GCM, ChaCha20-Poly1305)
// - Session tickets enabled for TLS session resumption
// - ECDSA P-256 keys for better performance than RSA
func loopbackTLSConfig() (*tls.Config, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "apple-music-linux engine (loopback)"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0), // regenerated on every start; no reason for it to outlive a year
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}

	// Configure TLS with strong settings
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		// Strong cipher suites only (AES-GCM and ChaCha20-Poly1305)
		CipherSuites: []uint16{
			tls.TLS_AES_128_GCM_SHA256,
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
		},
		// Enable session tickets for TLS session resumption (reduces handshake latency)
		SessionTicketsDisabled: false,
		// Session cache for resumption
		ClientSessionCache: tls.NewLRUClientSessionCache(32),
	}

	return tlsCfg, nil
}
