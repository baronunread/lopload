package main

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/backend/local"
	"github.com/rclone/rclone/backend/s3"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/object"
	"github.com/rclone/rclone/fs/operations"
	"github.com/zalando/go-keyring"
)

const keychainService = "lopload-native-spike"

var configOnce sync.Once
var remoteConfigError error
var errExists = errors.New("destination exists")
var errVerification = errors.New("verification failed")

type connection struct{ Endpoint, Bucket, AccessKey, SecretKey, Remote, LocalPath string }
type entry struct {
	Key    string
	Size   int64
	Folder bool
}
type storage struct {
	backend fs.Fs
	bucket  string
	cancel  context.CancelFunc
}

func configuredRemotes() ([]string, error) {
	configOnce.Do(func() {
		fs.GetConfig(context.Background()).AskPassword = false
		data := &configfile.Storage{}
		err := data.Load()
		if err != nil && !errors.Is(err, config.ErrorConfigFileNotFound) {
			remoteConfigError = err
			return
		}
		config.SetData(data)
	})
	if remoteConfigError != nil {
		return nil, remoteConfigError
	}
	return config.GetRemoteNames(), nil
}
func backendOptions(name string, values configmap.Simple) *configmap.Map {
	info, err := fs.Find(name)
	if err != nil {
		panic(err)
	}
	return fs.ConfigMap(name, info.Options, "", values)
}
func newStorage(s connection) (*storage, error) { return newStorageContext(context.Background(), s) }
func newStorageContext(ctx context.Context, s connection) (*storage, error) {
	// OAuth refresh retains the constructor context, so a connection outlives its task.
	parent := ctx
	ctx, closeConnection := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(parent, closeConnection)
	defer stop()
	connected := false
	defer func() {
		if !connected {
			closeConnection()
		}
	}()
	var backend fs.Fs
	var err error
	label := s.Bucket
	switch {
	case s.Remote != "":
		name, _, ok := strings.Cut(s.Remote, ":")
		found := false
		names, configErr := configuredRemotes()
		if configErr != nil {
			return nil, configErr
		}
		for _, known := range names {
			if name == known {
				found = true
			}
		}
		if !ok || !found {
			return nil, errors.New("choose a configured storage")
		}
		backend, err = fs.NewFs(ctx, s.Remote)
		label = s.Remote
	case s.LocalPath != "":
		root, pathErr := filepath.Abs(s.LocalPath)
		if pathErr != nil {
			return nil, pathErr
		}
		st, statErr := os.Stat(root)
		if statErr != nil {
			return nil, statErr
		}
		if !st.IsDir() {
			return nil, errors.New("choose a folder")
		}
		backend, err = local.NewFs(ctx, "lopload-local", root, backendOptions("local", configmap.Simple{}))
		label = root
	default:
		u, parseErr := url.Parse(s.Endpoint)
		if parseErr != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || s.Bucket == "" || strings.ContainsAny(s.Bucket, "/\\") {
			return nil, errors.New("invalid connection")
		}
		backend, err = s3.NewFs(ctx, "lopload-s3", s.Bucket, backendOptions("s3", configmap.Simple{"provider": "Other", "endpoint": s.Endpoint, "region": "us-east-1", "access_key_id": s.AccessKey, "secret_access_key": s.SecretKey, "force_path_style": "true", "upload_cutoff": "8Mi", "chunk_size": "8Mi", "upload_concurrency": "2", "directory_markers": "true"}))
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	connected = true
	return &storage{backend: backend, bucket: label, cancel: closeConnection}, nil
}
func (s *storage) close() {
	if s.cancel != nil {
		s.cancel()
	}
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
func validRemote(key string) bool {
	return key != "" && !strings.HasPrefix(key, "/") && !strings.Contains(key, "\\") && path.Clean(key) == key && key != ".." && !strings.HasPrefix(key, "../")
}
func validName(name string) bool {
	return validRemote(name) && !strings.ContainsAny(name, "/:") && name != "."
}
func (s *storage) list(ctx context.Context, prefix string) ([]entry, error) {
	dir := strings.TrimSuffix(prefix, "/")
	if dir != "" && !validRemote(dir) {
		return nil, errors.New("invalid folder")
	}
	listed, err := s.backend.List(ctx, dir)
	if errors.Is(err, fs.ErrorDirNotFound) {
		return []entry{}, nil
	}
	if err != nil {
		return nil, err
	}
	entries := make([]entry, 0, len(listed))
	for _, e := range listed {
		_, folder := e.(fs.Directory)
		key := e.Remote()
		if folder {
			key += "/"
		}
		entries = append(entries, entry{key, e.Size(), folder})
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
func readHash(ctx context.Context, r io.Reader) (string, error) {
	h := sha256.New()
	_, err := io.Copy(h, &progressReader{ctx: ctx, reader: r, notify: func(int64, int64) {}})
	return hex.EncodeToString(h.Sum(nil)), err
}
func (s *storage) vacant(ctx context.Context, key string) error {
	if !validRemote(key) {
		return errors.New("invalid file name")
	}
	_, err := s.backend.NewObject(ctx, key)
	if errors.Is(err, fs.ErrorObjectNotFound) {
		return nil
	}
	if err == nil {
		return errExists
	}
	return err
}
func (s *storage) verify(ctx context.Context, key string, size int64, want string) error {
	o, err := s.backend.NewObject(ctx, key)
	if err != nil {
		return err
	}
	if o.Size() >= 0 && o.Size() != size {
		return errVerification
	}
	r, err := o.Open(ctx)
	if err != nil {
		return err
	}
	got, err := readHash(ctx, r)
	closeErr := r.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if got != want {
		return errVerification
	}
	return nil
}
func (s *storage) upload(ctx context.Context, file, prefix string, notify func(int64, int64)) error {
	key := prefix + filepath.Base(file)
	if err := s.vacant(ctx, key); err != nil {
		return err
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return errors.New("choose a file")
	}
	sha, md := sha256.New(), md5.New()
	if _, err = io.Copy(io.MultiWriter(sha, md), &progressReader{ctx: ctx, reader: f, notify: func(int64, int64) {}}); err != nil {
		return err
	}
	want := hex.EncodeToString(sha.Sum(nil))
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	src := object.NewStaticObjectInfo(key, st.ModTime(), st.Size(), true, map[hash.Type]string{hash.MD5: hex.EncodeToString(md.Sum(nil)), hash.SHA256: want}, nil)
	if _, err = s.backend.Put(ctx, &progressReader{ctx: ctx, reader: f, total: st.Size(), notify: notify}, src); err != nil {
		return err
	}
	return s.verify(ctx, key, st.Size(), want)
}
func (s *storage) download(ctx context.Context, key, destination string, notify func(int64, int64)) error {
	if !validRemote(key) {
		return errors.New("invalid file")
	}
	o, err := s.backend.NewObject(ctx, key)
	if err != nil {
		return err
	}
	r, err := o.Open(ctx)
	if err != nil {
		return err
	}
	defer r.Close()
	temp, err := os.CreateTemp(filepath.Dir(destination), ".lopload-download-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	h := md5.New()
	n, err := io.Copy(io.MultiWriter(temp, h), &progressReader{ctx: ctx, reader: r, total: o.Size(), notify: notify})
	if err != nil {
		return err
	}
	if o.Size() >= 0 && n != o.Size() {
		return errVerification
	}
	if o.Fs().Hashes().Contains(hash.MD5) {
		want, err := o.Hash(ctx, hash.MD5)
		if err != nil {
			return err
		}
		if want != "" && hex.EncodeToString(h.Sum(nil)) != want {
			return errVerification
		}
	}
	if err = temp.Sync(); err != nil {
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if _, err = os.Stat(destination); !os.IsNotExist(err) {
		if err == nil {
			return errExists
		}
		return err
	}
	return os.Rename(temp.Name(), destination)
}
func (s *storage) mkdir(ctx context.Context, prefix, name string) error {
	if !validName(name) {
		return errors.New("invalid folder name")
	}
	key := prefix + name
	if !validRemote(key) {
		return errors.New("invalid folder")
	}
	return s.backend.Mkdir(ctx, key)
}
func (s *storage) remove(ctx context.Context, key string) error {
	if !validRemote(key) {
		return errors.New("invalid file")
	}
	o, err := s.backend.NewObject(ctx, key)
	if err != nil {
		return err
	}
	return o.Remove(ctx)
}
func (s *storage) copy(ctx context.Context, key, name string, move bool) error {
	if !validRemote(key) || !validName(name) {
		return errors.New("invalid file name")
	}
	dest := path.Join(path.Dir(key), name)
	if err := s.vacant(ctx, dest); err != nil {
		return err
	}
	o, err := s.backend.NewObject(ctx, key)
	if err != nil {
		return err
	}
	r, err := o.Open(ctx)
	if err != nil {
		return err
	}
	want, err := readHash(ctx, r)
	r.Close()
	if err != nil {
		return err
	}
	// Verify the destination before removing the original, including fallback copies.
	if err = operations.CopyFile(ctx, s.backend, s.backend, dest, key); err != nil {
		return err
	}
	if err = s.verify(ctx, dest, o.Size(), want); err != nil {
		return err
	}
	if move {
		return o.Remove(ctx)
	}
	return nil
}
