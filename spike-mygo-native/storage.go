package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/zalando/go-keyring"
)

const keychainService = "lopload-native-spike"

type connection struct{ Endpoint, Bucket, AccessKey, SecretKey string }
type entry struct {
	Key    string
	Size   int64
	Folder bool
}
type storage struct {
	client *minio.Client
	bucket string
}

func newStorage(s connection) (*storage, error) {
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || s.Bucket == "" {
		return nil, errors.New("invalid connection")
	}
	c, err := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(s.AccessKey, s.SecretKey, ""), Secure: u.Scheme == "https"})
	return &storage{c, s.Bucket}, err
}
func saveConnection(s connection) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return keyring.Set(keychainService, "default", string(b))
}
func loadConnection() (connection, error) {
	var s connection
	raw, err := keyring.Get(keychainService, "default")
	if err != nil {
		return s, err
	}
	err = json.Unmarshal([]byte(raw), &s)
	return s, err
}
func (s *storage) list(ctx context.Context, prefix string) ([]entry, error) {
	entries := []entry{}
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: false}) {
		if o.Err != nil {
			return nil, o.Err
		}
		entries = append(entries, entry{o.Key, o.Size, strings.HasSuffix(o.Key, "/")})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Folder != entries[j].Folder {
			return entries[i].Folder
		}
		return entries[i].Key < entries[j].Key
	})
	return entries, nil
}

type progressReader struct {
	ctx         context.Context
	reader      io.Reader
	sent, total int64
	last        time.Time
	notify      func(int64, int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	if err := p.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := p.reader.Read(b)
	p.sent += int64(n)
	if time.Since(p.last) >= 100*time.Millisecond || p.sent == p.total {
		p.notify(p.sent, p.total)
		p.last = time.Now()
	}
	return n, err
}
func (s *storage) upload(ctx context.Context, path, prefix string, notify func(int64, int64)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Size() > 5<<30 {
		return errors.New("unsupported file")
	}
	h := md5.New()
	if _, err = io.Copy(h, &progressReader{ctx: ctx, reader: f, total: st.Size(), notify: func(int64, int64) {}}); err != nil {
		return err
	}
	want := hex.EncodeToString(h.Sum(nil))
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	r := &progressReader{ctx: ctx, reader: f, total: st.Size(), notify: notify}
	key := prefix + filepath.Base(path)
	info, err := s.client.PutObject(ctx, s.bucket, key, r, st.Size(), minio.PutObjectOptions{DisableMultipart: true})
	if err != nil {
		return err
	}
	if strings.Trim(info.ETag, `"`) != want {
		return errors.New("verification failed")
	}
	remote, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return err
	}
	if remote.Size != st.Size() || strings.Trim(remote.ETag, `"`) != want {
		return errors.New("verification failed")
	}
	return nil
}
