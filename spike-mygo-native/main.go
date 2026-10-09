package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/rclone/rclone/fs"
)

type app struct {
	win                    *mygo.Window
	conn                   connection
	storage                *storage
	entries, visible       []entry
	prefix, search, status string
	filteredSearch         string
	selected               int
	list                   ui.ListState
	busy                   bool
	sent, total            int64
	cancel                 context.CancelFunc
	mode                   string
	remotes                []string
	actionName             string
	dialogBusy             bool
}

func newApp() *app {
	a := &app{conn: connection{Endpoint: "http://127.0.0.1:9400"}, mode: "s3", selected: -1, status: "Connect to your storage to browse files."}
	a.list.Selected = &a.selected
	a.list.Key = func(i int) any { return a.visible[i].Key }
	a.list.Label = func(i int) string { return a.visible[i].Key }
	return a
}
func (a *app) filter() {
	a.filteredSearch = a.search
	a.visible = nil
	for _, e := range a.entries {
		if strings.Contains(strings.ToLower(strings.TrimPrefix(e.Key, a.prefix)), strings.ToLower(a.search)) {
			a.visible = append(a.visible, e)
		}
	}
	a.selected = -1
}
func (a *app) run(message string, work func(context.Context) error, done func()) {
	if a.busy {
		return
	}
	ctx, cfg := fs.AddConfig(context.Background())
	cfg.LowLevelRetries = 1
	ctx, cancel := context.WithCancel(ctx)
	a.cancel = cancel
	a.busy = true
	a.status = message
	go func() {
		err := work(ctx)
		cancel()
		a.win.Update(func() {
			a.busy = false
			a.cancel = nil
			if errors.Is(err, context.Canceled) {
				a.status = "Canceled."
			} else if errors.Is(err, errExists) {
				a.status = "A file with that name already exists. Choose another name."
			} else if errors.Is(err, errVerification) {
				a.status = "Verification failed. The transferred file could not be confirmed."
			} else if err != nil {
				a.status = "Could not complete the action. Check your connection and access permissions."
			} else {
				a.status = "Ready."
				if done != nil {
					done()
				}
			}
		})
	}()
}
func (a *app) refresh() {
	var entries []entry
	s, p := a.storage, a.prefix
	a.run("Loading files…", func(ctx context.Context) error { var err error; entries, err = s.list(ctx, p); return err }, func() { a.entries = entries; a.filter() })
}
func (a *app) connect() {
	conn := a.conn
	if a.mode == "local" && conn.LocalPath == "" {
		a.status = "Choose a local folder first."
		return
	}
	if a.mode == "configured" && conn.Remote == "" {
		a.status = "Choose a configured storage location first."
		return
	}
	var s *storage
	var entries []entry
	a.run("Connecting…", func(ctx context.Context) error {
		var err error
		s, err = newStorageContext(ctx, conn)
		if err != nil {
			return err
		}
		entries, err = s.list(ctx, "")
		if err != nil {
			s.close()
			return err
		}
		if err = saveConnection(conn); err != nil {
			s.close()
			return err
		}
		return nil
	}, func() {
		a.storage = s
		a.conn.Bucket = s.bucket
		a.conn.AccessKey = ""
		a.conn.SecretKey = ""
		a.prefix = ""
		a.search = ""
		a.entries = entries
		a.filter()
	})
}
func (a *app) startUpload(file string) {
	s, p := a.storage, a.prefix
	a.sent, a.total = 0, 0
	var entries []entry
	var listErr error
	a.run("Checking "+path.Base(file)+"…", func(ctx context.Context) error {
		err := s.upload(ctx, file, p, func(sent, total int64) {
			a.win.Update(func() {
				a.sent, a.total = sent, total
				if total >= 0 && sent >= total {
					a.status = "Verifying file…"
				} else {
					a.status = "Uploading " + path.Base(file) + "…"
				}
			})
		})
		if err != nil {
			return err
		}
		entries, listErr = s.list(ctx, p)
		return nil
	}, func() {
		a.status = "Uploaded ✓ — file verified."
		if listErr == nil {
			a.entries = entries
			a.filter()
		} else {
			a.status = "Uploaded ✓ — refresh to reload the file list."
		}
	})
}
func (a *app) view(c *ui.Context) {
	t := c.Theme()
	t.Background = ui.Hex("#1b1d22")
	t.Surface = ui.Hex("#24272e")
	t.Text = ui.Hex("#e3e6eb")
	t.TextMuted = ui.Hex("#9099a6")
	t.Accent = ui.Hex("#a9c9f5")
	t.AccentText = ui.Hex("#1b1d22")
	c.SetTheme(t)
	ui.Column(c).Fill().Padding(24).Gap(16).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Gap(16).Children(func() {
			ui.Text(c, "Lopload").FontSize(26).Bold()
			ui.Text(c, "Native storage manager").TextColor(t.TextMuted)
		})
		if a.storage == nil {
			ui.Text(c, "Connect to storage").FontSize(18).Bold()
			ui.Row(c).Gap(10).Children(func() {
				for _, mode := range []string{"s3", "local", "configured"} {
					label := map[string]string{"s3": "S3 storage", "local": "Local folder", "configured": "Configured storage"}[mode]
					if ui.Button(c, label).Disabled(a.busy).Clicked() {
						a.mode = mode
						a.conn.Remote = ""
						a.conn.LocalPath = ""
					}
				}
			})
			switch a.mode {
			case "local":
				ui.TextInput(c, &a.conn.LocalPath).Label("Folder location").Width(480)
				if ui.Button(c, "Choose folder…").Disabled(a.busy || a.dialogBusy).Clicked() {
					a.chooseLocal()
				}
			case "configured":
				ui.Text(c, "Choose storage already set up with rclone.").TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Children(func() {
					for _, name := range a.remotes {
						if ui.Button(c, name).Clicked() {
							a.conn.Remote = name + ":"
						}
					}
				})
				ui.TextInput(c, &a.conn.Remote).Label("Storage location").Placeholder("my-storage:folder").Width(480)
				if ui.Button(c, "Reload configured storage").Disabled(a.busy).Clicked() {
					a.loadRemotes()
				}
			default:
				ui.TextInput(c, &a.conn.Endpoint).Label("Storage address").Placeholder("https://storage.example.com").Width(480)
				ui.TextInput(c, &a.conn.Bucket).Label("Storage name").Width(480)
				ui.TextInput(c, &a.conn.AccessKey).Label("Access ID").Width(480)
				ui.TextInput(c, &a.conn.SecretKey).Label("Secret").Password().Width(480)
			}

			if ui.PrimaryButton(c, "Connect and save").Disabled(a.busy).Clicked() {
				a.connect()
			}
		} else {
			ui.Text(c, a.storage.bucket+" / "+a.prefix).FontSize(18).Bold()
			ui.Row(c).Gap(10).Children(func() {
				if ui.Button(c, "Up").Disabled(a.busy || a.prefix == "").Clicked() {
					parent := path.Dir(strings.TrimSuffix(a.prefix, "/"))
					a.prefix = ""
					if parent != "." {
						a.prefix = parent + "/"
					}
					a.refresh()
				}
				if ui.Button(c, "Refresh").Disabled(a.busy).Clicked() {
					a.refresh()
				}
				if ui.PrimaryButton(c, "Upload a file…").Disabled(a.busy || a.dialogBusy).Clicked() {
					a.chooseUpload()
				}
				if ui.Button(c, "Change storage").Disabled(a.busy || a.dialogBusy).Clicked() {
					a.storage.close()
					a.storage = nil
					a.entries = nil
					a.visible = nil
					a.prefix = ""
					a.conn = connection{Endpoint: "http://127.0.0.1:9400"}
					a.status = "Connect to your storage to browse files."
				}

				ui.TextInput(c, &a.search).Label("Search files").Placeholder("Search files").Grow(1)
				if a.filteredSearch != a.search {
					a.filter()
				}
			})
			a.actions(c)
			ui.Row(c).Children(func() {
				ui.Text(c, "Name").Grow(1).TextColor(t.TextMuted)
				ui.Text(c, "Size").Width(120).TextColor(t.TextMuted)
			})
			if len(a.visible) == 0 {
				ui.Text(c, "No files here.").TextColor(t.TextMuted)
			}
			list := ui.List(c, &a.list, len(a.visible), func(i int) {
				e := a.visible[i]
				ui.Row(c).Height(36).AlignItems(ui.Center).Children(func() {
					name := strings.TrimPrefix(e.Key, a.prefix)
					if e.Folder {
						name = "Folder · " + strings.TrimSuffix(name, "/")
					}
					ui.Text(c, name).Grow(1)
					size := "—"
					if !e.Folder && e.Size >= 0 {
						size = formatBytes(e.Size)
					}
					ui.Text(c, size).Width(120).TextColor(t.TextMuted)
				})
			}).Grow(1)
			if list.Submitted() && a.selected >= 0 && a.selected < len(a.visible) && !a.busy {
				e := a.visible[a.selected]
				if e.Folder {
					a.prefix = e.Key
					a.search = ""
					a.refresh()
				}
			}
			ui.Textf(c, "%d items", len(a.visible)).TextColor(t.TextMuted)
		}
		ui.Text(c, a.status).TextColor(t.TextMuted)
		if a.busy {
			ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
				value := 0.0
				if a.total > 0 {
					value = float64(a.sent) / float64(a.total)
				}
				ui.Progress(c, value).Grow(1)
				if a.total >= 0 {
					ui.Text(c, formatBytes(a.sent)+" / "+formatBytes(a.total))
				} else {
					ui.Text(c, formatBytes(a.sent))
				}
				if ui.Button(c, "Cancel").Clicked() && a.cancel != nil {
					a.cancel()
				}
			})
		}
	})
}
func formatBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	if n < 1<<20 {
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
}
func main() {
	a := newApp()
	benchmark := len(os.Args) > 1 && os.Args[1] == "--benchmark"
	mygo.App.WhenReady(func() {
		a.win = mygo.NewWindow(mygo.WindowOptions{Title: "Lopload · Native MyGo", Width: 1000, Height: 720, MinWidth: 700, MinHeight: 560, Content: ui.View(a.view)})
		a.win.OnClose(func(e *mygo.CloseEvent) {
			if a.cancel != nil {
				a.cancel()
			}
			if a.storage != nil {
				a.storage.close()
			}
		})
		if benchmark {
			go a.benchmark()
			return
		}
		go func() {
			conn, err := loadConnection()
			var s *storage
			if err == nil {
				s, err = newStorage(conn)
			}
			a.win.Update(func() {
				if err == nil {
					a.conn = conn
					a.storage = s
					a.conn.AccessKey = ""
					a.conn.SecretKey = ""
					if conn.Remote != "" {
						a.mode = "configured"
					} else if conn.LocalPath != "" {
						a.mode = "local"
					}
					a.refresh()
				}
			})

		}()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
