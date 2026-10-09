package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
	"github.com/zalando/go-keyring"
)

// Needs the test MinIO on :9400 with a "spike" bucket, and the real OS keychain.
func TestUploadVerifies(t *testing.T) {
	s := Storage{}
	if err := s.Connect("http://127.0.0.1:9400", "spike", "minioadmin", "minioadmin"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = keyring.Delete(keychainService, "default") })

	conn, err := s.Current()
	if err != nil || conn == nil || conn.Bucket != "spike" {
		t.Fatalf("current = %+v, %v", conn, err)
	}

	path := filepath.Join(t.TempDir(), "hello.bin")
	if err := os.WriteFile(path, make([]byte, 3<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := upload(context.Background(), path, &mygo.Channel[Progress]{})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Verified || r.Size != 3<<20 {
		t.Fatalf("upload = %+v", r)
	}

	files, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if f.Key == "hello.bin" && f.Size == 3<<20 {
			return
		}
	}
	t.Fatalf("hello.bin not listed: %+v", files)
}
