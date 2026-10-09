package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"
	"github.com/minio/minio-go/v7"
)

// This opt-in fixture uses only a fresh local MinIO bucket and temporary files.
func (a *app) benchmark() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	s, err := newStorage(connection{"http://127.0.0.1:9400", fmt.Sprintf("lopload-native-bench-%d", time.Now().UnixNano()), "minioadmin", "minioadmin"})
	if err != nil {
		logBenchmarkError(err)
		return
	}
	if err = s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{}); err != nil {
		logBenchmarkError(err)
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Recursive: true}) {
			if o.Err == nil {
				s.client.RemoveObject(ctx, s.bucket, o.Key, minio.RemoveObjectOptions{})
			}
		}
		s.client.RemoveBucket(ctx, s.bucket)
	}()
	dir, err := os.MkdirTemp("", "lopload-native-bench-")
	if err != nil {
		logBenchmarkError(err)
		return
	}
	defer os.RemoveAll(dir)
	for i := 0; i < 1000; i++ {
		key := fmt.Sprintf("documents/file-%04d.txt", i)
		if _, err = s.client.PutObject(ctx, s.bucket, key, nil, 0, minio.PutObjectOptions{DisableMultipart: true}); err != nil {
			logBenchmarkError(err)
			return
		}
	}
	entries, err := s.list(ctx, "documents/")
	if err != nil {
		logBenchmarkError(err)
		return
	}
	ready := make(chan struct{})
	a.win.Update(func() {
		a.storage = s
		a.conn.Bucket = s.bucket
		a.prefix = "documents/"
		a.entries = entries
		a.filter()
		a.status = "Benchmark: 1,000 real files. Idle for 15 seconds."
		close(ready)
	})
	<-ready
	fmt.Println("BENCHMARK_IDLE")
	time.Sleep(15 * time.Second)
	captured := make(chan struct{})
	a.win.Update(func() {
		if png, err := a.win.CapturePage(); err == nil {
			os.WriteFile(filepath.Join(os.TempDir(), "lopload-native-window.png"), png, 0600)
		} else {
			fmt.Printf("BENCHMARK_CAPTURE_FAILED %v\n", err)
		}
		close(captured)
	})
	<-captured
	file := filepath.Join(dir, "large.bin")
	f, err := os.Create(file)
	if err != nil {
		logBenchmarkError(err)
		return
	}
	err = f.Truncate(1 << 30)
	f.Close()
	if err != nil {
		logBenchmarkError(err)
		return
	}
	started := time.Now()
	fmt.Println("BENCHMARK_UPLOAD_START")
	ready = make(chan struct{})
	a.win.Update(func() { a.startUpload(file); close(ready) })
	<-ready
	// Read UI state only on the main thread, including the completion condition.
	for {
		done := make(chan bool, 1)
		a.win.Update(func() { done <- !a.busy })
		if <-done {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	obj, err := s.client.GetObject(ctx, s.bucket, "documents/large.bin", minio.GetObjectOptions{})
	if err != nil {
		logBenchmarkError(err)
		return
	}
	n, err := io.Copy(io.Discard, obj)
	obj.Close()
	if err != nil || n != 1<<30 {
		logBenchmarkError(fmt.Errorf("remote read: %d bytes, %v", n, err))
		return
	}
	fmt.Printf("BENCHMARK_UPLOAD_DONE bytes=%d elapsed=%s\n", n, time.Since(started))
	time.Sleep(10 * time.Second)
	fmt.Println("BENCHMARK_DONE")
	go func() { time.Sleep(time.Second); mygo.App.Quit() }()
}
func logBenchmarkError(err error) { fmt.Printf("BENCHMARK_FAILED %T\n", err); mygo.App.Quit() }
