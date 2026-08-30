// Package bench is a no-op timing stub. The real implementation lives in the
// apple-music-engine-dev repo; this stub satisfies the import so the binary
// can be built from this repo without the full instrumentation layer.
package bench

import "context"

type Tracer struct{}

func FromContext(_ context.Context) *Tracer  { return &Tracer{} }

func (*Tracer) RecordWebplaybackStart()     {}
func (*Tracer) RecordWebplaybackEnd()       {}
func (*Tracer) RecordCatalogFetchStart()    {}
func (*Tracer) RecordCatalogFetchEnd()      {}
func (*Tracer) RecordLicenseStart()         {}
func (*Tracer) RecordLicenseEnd()           {}
func (*Tracer) RecordPlaybackReady()        {}
func (*Tracer) RecordRetry()                {}
func (*Tracer) RecordCBCSDialStart()        {}
func (*Tracer) RecordCBCSDialConnected()    {}
func (*Tracer) RecordCBCSDownloadStart()    {}
