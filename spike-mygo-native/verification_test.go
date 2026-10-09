package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

type corruptReadCloser struct {
	io.ReadCloser
	changed bool
}

func (r *corruptReadCloser) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	if n > 0 && !r.changed {
		b[0] ^= 1
		r.changed = true
	}
	return n, err
}
func TestCorruptedReadbackFailsVerification(t *testing.T) {
	real := testStorage(t)
	target, _ := url.Parse("http://127.0.0.1:9400")
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.Request.Method == http.MethodGet && resp.StatusCode == http.StatusOK && resp.Request.URL.Path == "/"+real.bucket+"/fault.bin" {
			resp.Body = &corruptReadCloser{ReadCloser: resp.Body}
		}
		return nil
	}
	server := httptest.NewServer(proxy)
	defer server.Close()
	s, err := newStorage(connection{Endpoint: server.URL, Bucket: real.bucket, AccessKey: "minioadmin", SecretKey: "minioadmin"})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "fault.bin")
	if err = os.WriteFile(file, []byte("genuine upload with a corrupted verification response"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = s.upload(context.Background(), file, "", func(int64, int64) {}); !errors.Is(err, errVerification) {
		t.Fatalf("corrupt readback was not detected: %v", err)
	}
}
