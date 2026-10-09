package main

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/minio/minio-go/v7"
	"github.com/zalando/go-keyring"
)

func testStorage(t *testing.T) *storage {
	t.Helper()
	s, err := newStorage(connection{"http://127.0.0.1:9400", fmt.Sprintf("lopload-native-%d", time.Now().UnixNano()), "minioadmin", "minioadmin"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Recursive: true}) {
			if o.Err != nil {
				t.Error(o.Err)
				continue
			}
			if err := s.client.RemoveObject(ctx, s.bucket, o.Key, minio.RemoveObjectOptions{}); err != nil {
				t.Error(err)
			}
		}
		if err := s.client.RemoveBucket(ctx, s.bucket); err != nil {
			t.Error(err)
		}
	})
	return s
}
func TestNativeStorage(t *testing.T) {
	s := testStorage(t)
	ctx := context.Background()
	data := bytes.Repeat([]byte("verified native transfer\n"), 131072)
	file := filepath.Join(t.TempDir(), "sample.bin")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	var sent, total int64
	if err := s.upload(ctx, file, "folder/", func(n, size int64) {
		if n < sent || n > size {
			t.Errorf("invalid progress %d/%d", n, size)
		}
		sent, total = n, size
	}); err != nil {
		t.Fatal(err)
	}
	if sent != int64(len(data)) || total != sent {
		t.Fatalf("progress %d/%d", sent, total)
	}
	entries, err := s.list(ctx, "")
	if err != nil || len(entries) != 1 || !entries[0].Folder {
		t.Fatalf("root %+v, %v", entries, err)
	}
	entries, err = s.list(ctx, "folder/")
	if err != nil || len(entries) != 1 || entries[0].Size != int64(len(data)) {
		t.Fatalf("folder %+v, %v", entries, err)
	}
	probe, err := newStorage(connection{"http://127.0.0.1:9400", s.bucket, "minioadmin", "minioadmin"})
	if err != nil {
		t.Fatal(err)
	}
	remote, err := probe.client.GetObject(ctx, s.bucket, "folder/sample.bin", minio.GetObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(remote)
	remote.Close()
	if err != nil || !bytes.Equal(data, got) {
		t.Fatalf("stored bytes differ: %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.upload(canceled, file, "cancel/", func(int64, int64) {}); err == nil {
		t.Fatal("canceled upload succeeded")
	}
	entries, err = s.list(ctx, "cancel/")
	if err != nil || len(entries) != 0 {
		t.Fatalf("canceled file stored: %+v %v", entries, err)
	}
	mid, cancelMid := context.WithCancel(ctx)
	if err := s.upload(mid, file, "mid-cancel/", func(int64, int64) { cancelMid() }); err == nil {
		t.Fatal("mid-transfer cancellation succeeded")
	}
	entries, err = s.list(ctx, "mid-cancel/")
	if err != nil || len(entries) != 0 {
		t.Fatalf("partially canceled file stored: %+v %v", entries, err)
	}
	a := newApp()
	a.storage = s
	a.conn.Bucket = s.bucket
	a.entries, err = s.list(ctx, "folder/")
	if err != nil {
		t.Fatal(err)
	}
	a.prefix = "folder/"
	a.filter()
	tt := ui.NewTester(a.view, 1000, 720)
	if !tt.HasText("sample.bin") {
		t.Fatalf("file missing in native view: %q", tt.Texts())
	}
	if err := tt.Click("Search files"); err != nil {
		t.Fatal(err)
	}
	tt.Type("missing")
	if len(a.visible) != 0 || !tt.HasText("No files here.") {
		t.Fatalf("search did not filter: %q", tt.Texts())
	}
}
func TestKeychainRoundTrip(t *testing.T) {
	s := connection{"http://127.0.0.1:9400", "native-test", "dummy-access", "dummy-secret"}
	if err := saveConnection(s); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := keyring.Delete(keychainService, "default"); err != nil {
			t.Error(err)
		}
	})
	got, err := loadConnection()
	if err != nil || got != s {
		t.Fatalf("keychain round trip failed: %v", err)
	}
}
func TestVirtualizedList(t *testing.T) {
	a := newApp()
	a.storage = testStorage(t)
	a.conn.Bucket = "Native file browser"
	for i := 0; i < 10000; i++ {
		a.entries = append(a.entries, entry{Key: fmt.Sprintf("file-%05d.txt", i), Size: 1024})
	}
	a.filter()
	tt := ui.NewTester(a.view, 1000, 720)
	first, last := a.list.Visible()
	if last-first > 100 {
		t.Fatalf("not virtualized: %d visible rows", last-first)
	}
	if err := tt.Click("file-00000.txt"); err != nil {
		t.Fatal(err)
	}
	tt.Key(0, ui.KeyEnd)
	if a.selected != 9999 {
		t.Fatalf("keyboard selection %d", a.selected)
	}
	if dir := os.Getenv("SPIKE_ARTIFACT_DIR"); dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(filepath.Join(dir, "native-list.png"))
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := png.Encode(f, tt.Image()); err != nil {
			t.Fatal(err)
		}
	}
}
