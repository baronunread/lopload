package main

import (
	"context"
	"path"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func (a *app) loadRemotes() {
	var names []string
	a.run("Loading configured storage…", func(context.Context) error { var err error; names, err = configuredRemotes(); return err }, func() {
		a.remotes = names
		if len(names) == 0 {
			a.status = "No configured storage found. Set up a connection with rclone first."
		}
	})
}
func (a *app) chooseLocal() {
	a.dialogBusy = true
	go func() {
		files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.win, Title: "Choose a local folder", Directory: true})
		a.win.Update(func() {
			a.dialogBusy = false
			if err != nil {
				a.status = "Could not open the folder picker."
			} else if len(files) > 0 {
				a.conn.LocalPath = files[0]
			}
		})
	}()
}
func (a *app) chooseUpload() {
	a.dialogBusy = true
	go func() {
		files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.win, Title: "Upload a file"})
		a.win.Update(func() {
			a.dialogBusy = false
			if err != nil {
				a.status = "Could not open the file picker."
			} else if len(files) > 0 {
				a.startUpload(files[0])
			}
		})
	}()
}
func (a *app) mutate(message string, work func(context.Context) error) {
	s, p := a.storage, a.prefix
	var entries []entry
	var listErr error
	a.run(message, func(ctx context.Context) error {
		if err := work(ctx); err != nil {
			return err
		}
		entries, listErr = s.list(ctx, p)
		return nil
	}, func() {
		a.status = "Done."
		if listErr == nil {
			a.entries = entries
			a.filter()
		} else {
			a.status = "Done. Refresh to reload the file list."
		}
	})
}
func (a *app) selectedFile() (entry, bool) {
	if a.selected < 0 || a.selected >= len(a.visible) {
		return entry{}, false
	}
	e := a.visible[a.selected]
	return e, !e.Folder
}
func (a *app) chooseDownload(e entry) {
	a.dialogBusy = true
	s := a.storage
	go func() {
		file, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: a.win, Title: "Save file", DefaultPath: path.Base(e.Key)})
		a.win.Update(func() {
			a.dialogBusy = false
			if err != nil {
				a.status = "Could not open the save dialog."
			} else if file != "" {
				a.sent, a.total = 0, 0
				a.run("Downloading…", func(ctx context.Context) error {
					return s.download(ctx, e.Key, file, func(sent, total int64) { a.win.Update(func() { a.sent, a.total = sent, total }) })
				}, func() { a.status = "Downloaded ✓" })
			}
		})
	}()
}
func (a *app) confirmDelete(e entry) {
	a.dialogBusy = true
	s := a.storage
	go func() {
		result, err := mygo.Dialog.Message(mygo.MessageOptions{Parent: a.win, Type: mygo.MessageWarning, Title: "Delete file?", Message: "Delete " + path.Base(e.Key) + "?", Detail: "This permanently deletes the file from your storage.", Buttons: []string{"Cancel", "Delete"}, DefaultButton: 0, CancelButton: 0})
		a.win.Update(func() {
			a.dialogBusy = false
			if err != nil {
				a.status = "Could not open the confirmation."
			} else if result.Button == 1 {
				a.mutate("Deleting…", func(ctx context.Context) error { return s.remove(ctx, e.Key) })
			}
		})
	}()
}
func (a *app) actions(c *ui.Context) {
	e, selected := a.selectedFile()
	disabled := a.busy || a.dialogBusy
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		if ui.Button(c, "Download…").Disabled(disabled || !selected).Clicked() {
			a.chooseDownload(e)
		}
		if ui.Button(c, "Delete…").Disabled(disabled || !selected).Clicked() {
			a.confirmDelete(e)
		}
		ui.TextInput(c, &a.actionName).Label("New name").Placeholder("New name").Grow(1)
		s, p, name := a.storage, a.prefix, a.actionName
		if ui.Button(c, "New folder").Disabled(disabled || !validName(name)).Clicked() {
			a.mutate("Creating folder…", func(ctx context.Context) error { return s.mkdir(ctx, p, name) })
		}
		if ui.Button(c, "Copy").Disabled(disabled || !selected || !validName(name)).Clicked() {
			a.mutate("Copying and verifying…", func(ctx context.Context) error { return s.copy(ctx, e.Key, name, false) })
		}
		if ui.Button(c, "Rename").Disabled(disabled || !selected || !validName(name)).Clicked() {
			a.mutate("Renaming and verifying…", func(ctx context.Context) error { return s.copy(ctx, e.Key, name, true) })
		}
	})
}
