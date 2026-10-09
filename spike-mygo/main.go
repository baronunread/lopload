package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/zalando/go-keyring"
)

const keychainService = "lopload-spike"

type secret struct {
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

// Storage is the page's only way to reach the bucket. Keys go in once via
// Connect and never come back out: signing happens here, in Go.
type Storage struct{}

// Connection is what the page is allowed to know about a saved connection.
type Connection struct {
	Endpoint string `json:"endpoint"`
	Bucket   string `json:"bucket"`
}

// Progress reports bytes sent for the current upload.
type Progress struct {
	Sent  int64 `json:"sent"`
	Total int64 `json:"total"`
}

// Uploaded is the result of an upload, verified by local MD5 against the ETag.
type Uploaded struct {
	Key      string `json:"key"`
	Size     int64  `json:"size"`
	Verified bool   `json:"verified"`
}

// Entry is one file in the bucket.
type Entry struct {
	Key  string `json:"key"`
	Size int64  `json:"size"`
}

// Connect stores the connection in the OS keychain.
func (Storage) Connect(endpoint, bucket, accessKey, secretKey string) error {
	b, err := json.Marshal(secret{endpoint, bucket, accessKey, secretKey})
	if err != nil {
		return err
	}
	return keyring.Set(keychainService, "default", string(b))
}

// Current returns the saved connection without its keys, or nil.
func (Storage) Current() (*Connection, error) {
	s, err := load()
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Connection{s.Endpoint, s.Bucket}, nil
}

// List returns the files in the bucket.
func (Storage) List(ctx context.Context) ([]Entry, error) {
	c, s, err := client()
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	for o := range c.ListObjects(ctx, s.Bucket, minio.ListObjectsOptions{Recursive: true}) {
		if o.Err != nil {
			return nil, o.Err
		}
		entries = append(entries, Entry{o.Key, o.Size})
	}
	return entries, nil
}

// PickAndUpload asks for a file and uploads it. Returns nil when the user cancels.
func (Storage) PickAndUpload(ctx context.Context, out *mygo.Channel[Progress]) (*Uploaded, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "Upload"})
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	return upload(ctx, paths[0], out)
}

func upload(ctx context.Context, path string, out *mygo.Channel[Progress]) (*Uploaded, error) {
	c, s, err := client()
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	want := hex.EncodeToString(h.Sum(nil))
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	key := filepath.Base(path)
	// ponytail: single PUT only (S3 caps it at 5 GiB); multipart + composite ETag is the real port.
	info, err := c.PutObject(ctx, s.Bucket, key, f, st.Size(), minio.PutObjectOptions{
		DisableMultipart: true,
		Progress:         &progress{total: st.Size(), out: out},
	})
	if err != nil {
		return nil, err
	}
	return &Uploaded{key, st.Size(), strings.Trim(info.ETag, `"`) == want}, nil
}

// progress is read by minio-go as bytes go out.
type progress struct {
	sent, total int64
	out         *mygo.Channel[Progress]
}

func (p *progress) Read(b []byte) (int, error) {
	p.sent += int64(len(b))
	_ = p.out.Send(Progress{p.sent, p.total})
	return len(b), nil
}

func load() (secret, error) {
	var s secret
	raw, err := keyring.Get(keychainService, "default")
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal([]byte(raw), &s)
}

func client() (*minio.Client, secret, error) {
	s, err := load()
	if err != nil {
		return nil, s, err
	}
	u, err := url.Parse(s.Endpoint)
	if err != nil {
		return nil, s, err
	}
	c, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(s.AccessKey, s.SecretKey, ""),
		Secure: u.Scheme == "https",
	})
	return c, s, err
}

func main() {
	mygo.Bind(Storage{})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:     "Lopload (MyGo spike)",
			Width:     960,
			Height:    640,
			MinWidth:  480,
			MinHeight: 360,
			URL:       "/",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
