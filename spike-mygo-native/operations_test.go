package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/minio/minio-go/v7"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
)

func TestFileActions(t *testing.T) {
	for _, kind := range []string{"s3", "local"} {
		t.Run(kind, func(t *testing.T) {
			var s *storage
			var err error
			if kind == "s3" {
				s = testStorage(t)
			} else {
				s, err = newStorage(connection{LocalPath: t.TempDir()})
				if err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(s.close)
			ctx := context.Background()
			dir := t.TempDir()
			source := filepath.Join(dir, "source.txt")
			want := []byte("real storage, real file operations\n")
			if err = os.WriteFile(source, want, 0600); err != nil {
				t.Fatal(err)
			}
			if err = s.upload(ctx, source, "", func(int64, int64) {}); err != nil {
				t.Fatal(err)
			}
			if err = s.upload(ctx, source, "", func(int64, int64) {}); !errors.Is(err, errExists) {
				t.Fatalf("overwrite not rejected: %v", err)
			}
			if err = s.copy(ctx, "source.txt", "copied.txt", false); err != nil {
				t.Fatal(err)
			}
			if err = s.copy(ctx, "copied.txt", "renamed.txt", true); err != nil {
				t.Fatal(err)
			}
			if _, err = s.backend.NewObject(ctx, "copied.txt"); !errors.Is(err, fs.ErrorObjectNotFound) {
				t.Fatalf("original remains after rename: %v", err)
			}
			downloaded := filepath.Join(dir, "downloaded.txt")
			if err = s.download(ctx, "renamed.txt", downloaded, func(int64, int64) {}); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(downloaded)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("downloaded bytes differ: %v", err)
			}
			if err = s.download(ctx, "renamed.txt", downloaded, func(int64, int64) {}); !errors.Is(err, errExists) {
				t.Fatalf("download overwrote local file: %v", err)
			}
			if kind == "s3" {
				remote, err := probeClient(t).GetObject(ctx, s.bucket, "renamed.txt", minio.GetObjectOptions{})
				if err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(remote)
				remote.Close()
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("copied storage bytes differ: %v", err)
				}
			}
			if err = s.remove(ctx, "renamed.txt"); err != nil {
				t.Fatal(err)
			}
			if _, err = s.backend.NewObject(ctx, "renamed.txt"); !errors.Is(err, fs.ErrorObjectNotFound) {
				t.Fatalf("deleted file remains: %v", err)
			}
			if err = s.mkdir(ctx, "", "new-folder"); err != nil {
				t.Fatal(err)
			}
			entries, err := s.list(ctx, "")
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, e := range entries {
				if e.Key == "new-folder/" && e.Folder {
					found = true
				}
			}
			if !found {
				t.Fatalf("folder missing: %+v", entries)
			}
			for _, name := range []string{"../escape", "/absolute", "back\\slash", "."} {
				if err = s.copy(ctx, "source.txt", name, false); err == nil {
					t.Fatalf("unsafe name accepted %q", name)
				}
			}
		})
	}
}
func TestMultipartUpload(t *testing.T) {
	s := testStorage(t)
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "multipart.bin")
	data := bytes.Repeat([]byte("rclone-multipart"), 2<<20)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.upload(ctx, file, "", func(int64, int64) {}); err != nil {
		t.Fatal(err)
	}
	info, err := probeClient(t).StatObject(ctx, s.bucket, "multipart.bin", minio.StatObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(info.ETag, "-") {
		t.Fatalf("expected multipart transfer, got %q", info.ETag)
	}
	r, err := probeClient(t).GetObject(ctx, s.bucket, "multipart.bin", minio.GetObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(r)
	r.Close()
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("multipart stored bytes differ: %v", err)
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	if err = s.upload(cancelCtx, file, "cancel/", func(int64, int64) { cancel() }); err == nil {
		t.Fatal("multipart cancellation succeeded")
	}
	for upload := range probeClient(t).ListIncompleteUploads(ctx, s.bucket, "", true) {
		if upload.Err != nil {
			t.Fatal(upload.Err)
		}
		t.Errorf("incomplete upload remains: %s", upload.Key)
	}
}
func TestConfiguredStorage(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "profile-file.txt"), []byte("configured storage"), 0600); err != nil {
		t.Fatal(err)
	}
	old := config.GetConfigPath()
	file := filepath.Join(t.TempDir(), "rclone.conf")
	if err := os.WriteFile(file, []byte(fmt.Sprintf("[native-test]\ntype = alias\nremote = %s\n", root)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := config.SetConfigPath(file); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { config.SetConfigPath(old) })
	names, err := configuredRemotes()
	if err != nil || len(names) != 1 || names[0] != "native-test" {
		t.Fatalf("configured names %+v %v", names, err)
	}
	s, err := newStorage(connection{Remote: "native-test:"})
	if err != nil {
		t.Fatal(err)
	}
	entries, err := s.list(context.Background(), "")
	if err != nil || len(entries) != 1 || entries[0].Key != "profile-file.txt" {
		t.Fatalf("configured listing %+v %v", entries, err)
	}
}
