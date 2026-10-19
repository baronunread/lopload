//! Lopload storage browser spike on nanoui (Zig, native UI drawn with Metal).
//! Same scope as the S3-only MyGo spike: connect, browse folders, search a
//! virtualized list, upload with progress, cancel, and verify by SHA-256 readback.
const std = @import("std");
const nanoui = @import("nanoui");
const s3 = @import("s3");
const ui = nanoui.ui;
const builtin = @import("builtin");

const row_h: f32 = 36;
const default_endpoint = "http://127.0.0.1:9400";

/// A connection: the client and the strings its config points at.
pub const Session = struct {
    arena: std.heap.ArenaAllocator,
    client: s3.Client,

    pub fn open(gpa: std.mem.Allocator, io: std.Io, cfg: s3.Config) !*Session {
        const s = try gpa.create(Session);
        errdefer gpa.destroy(s);
        s.arena = .init(gpa);
        errdefer s.arena.deinit();
        const a = s.arena.allocator();
        s.client = try s3.Client.init(gpa, io, .{
            .endpoint = try a.dupe(u8, cfg.endpoint),
            .bucket = try a.dupe(u8, cfg.bucket),
            .access_key = try a.dupe(u8, cfg.access_key),
            .secret_key = try a.dupe(u8, cfg.secret_key),
        });
        return s;
    }

    pub fn close(s: *Session, gpa: std.mem.Allocator) void {
        s.client.deinit();
        s.arena.deinit();
        gpa.destroy(s);
    }
};

/// One folder level, with its strings.
pub const Listing = struct {
    arena: std.heap.ArenaAllocator,
    prefix: []const u8,
    entries: []s3.Entry,

    pub fn load(gpa: std.mem.Allocator, client: *s3.Client, prefix: []const u8) !*Listing {
        const l = try gpa.create(Listing);
        errdefer gpa.destroy(l);
        l.arena = .init(gpa);
        errdefer l.arena.deinit();
        const a = l.arena.allocator();
        l.prefix = try a.dupe(u8, prefix);
        l.entries = try client.list(a, prefix);
        return l;
    }

    pub fn free(l: *Listing, gpa: std.mem.Allocator) void {
        l.arena.deinit();
        gpa.destroy(l);
    }
};

pub const Kind = union(enum) { connect, list, upload: []const u8 };

/// Work for a background thread. Inputs are set before it starts, outputs before it reports back.
pub const Job = struct {
    app: *App,
    kind: Kind,
    arena: std.heap.ArenaAllocator,
    cfg: s3.Config,
    prefix: []const u8,
    session: ?*Session,
    thread: std.Thread = undefined,
    err: ?anyerror = null,
    listing: ?*Listing = null,
    listing_err: bool = false,
    http_status: u16 = 0,
    done: std.atomic.Value(bool) = .init(false),

    fn run(job: *Job) void {
        const app = job.app;
        defer job.done.store(true, .release);
        defer if (job.err != null) {
            if (job.session) |s| job.http_status = s.client.last_status;
        };
        const gpa = app.gpa;
        const a = job.arena.allocator();
        switch (job.kind) {
            .connect => {
                const s = Session.open(gpa, app.io, job.cfg) catch |e| {
                    job.err = e;
                    return;
                };
                job.session = s;
                job.listing = Listing.load(gpa, &s.client, "") catch |e| {
                    job.err = e;
                    return;
                };
            },
            .list => {
                job.listing = Listing.load(gpa, &job.session.?.client, job.prefix) catch |e| {
                    job.err = e;
                    return;
                };
            },
            .upload => |path| {
                const key = std.fmt.allocPrint(a, "{s}{s}", .{ job.prefix, std.fs.path.basename(path) }) catch {
                    job.err = error.OutOfMemory;
                    return;
                };
                job.session.?.client.uploadVerified(a, path, key, &app.progress) catch |e| {
                    job.err = e;
                    return;
                };
                job.listing = Listing.load(gpa, &job.session.?.client, job.prefix) catch blk: {
                    job.listing_err = true;
                    break :blk null;
                };
            },
        }
    }

    /// Main thread, once `done` is set (see `App.tick`).
    fn finish(job: *Job) void {
        const app = job.app;
        job.thread.join();
        defer {
            job.arena.deinit();
            app.gpa.destroy(job);
        }
        if (job.kind == .connect) {
            if (job.err) |_| {
                if (job.session) |s| s.close(app.gpa);
            } else {
                if (app.session) |old| old.close(app.gpa);
                app.session = job.session;
            }
        }
        if (job.listing) |l| app.setListing(l);
        const kind = std.meta.activeTag(job.kind);
        if (job.err) |e| {
            app.say("{s}", .{message(kind, e, job.http_status)});
        } else switch (kind) {
            .upload => app.say("{s}", .{if (job.listing_err) "Uploaded ✓ — refresh to reload the file list." else "Uploaded ✓ — file verified."}),
            .connect => app.say("Connected.", .{}),
            .list => app.say("Ready.", .{}),
        }
        // Last, so a thread watching `busy` sees the final status.
        app.setBusy(false);
        app.win.redraw();
    }

    fn message(kind: std.meta.Tag(Kind), e: anyerror, status: u16) []const u8 {
        return switch (e) {
            error.Canceled => "Canceled.",
            error.Exists => "A file with that name already exists. Choose another name.",
            error.VerificationFailed => "Verification failed. The transferred file could not be confirmed.",
            error.HttpStatus => if (status == 403) "Access denied. Check the access ID and secret." else if (status == 404) "That storage name was not found." else "The storage service refused the request.",
            else => if (kind == .connect) "Could not connect. Check the address and your network." else "Could not complete the action. Check your connection and access permissions.",
        };
    }
};

pub const App = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    nano: *nanoui.App,
    win: *nanoui.Window = undefined,

    endpoint: ui.TextBuffer = .{},
    bucket: ui.TextBuffer = .{},
    access: ui.TextBuffer = .{},
    secret: ui.TextBuffer = .{},
    search: ui.TextBuffer = .{},

    session: ?*Session = null,
    listing: ?*Listing = null,
    visible: std.ArrayList(u32) = .empty,
    selected: ?usize = null,
    scroll_to: ?f32 = null,

    status_buf: [200]u8 = undefined,
    status: []const u8 = "Connect to your storage to browse files.",
    busy: std.atomic.Value(bool) = .init(false),
    progress: s3.Progress = .{},
    ticking: bool = false,
    /// The running job, main thread only.
    job: ?*Job = null,
    endpoint_seeded: bool = false,

    pub fn setBusy(app: *App, on: bool) void {
        app.busy.store(on, .release);
        if (on and !app.ticking) {
            app.ticking = true;
            nanoui.App.after(100, app, tick);
        }
    }

    /// While a job runs: repaint so progress moves, and finish the job once its thread is done.
    /// Main thread only, via `App.after`, which every platform has; the timer stops with the job,
    /// so an idle app schedules nothing.
    fn tick(ctx: ?*anyopaque) callconv(.c) void {
        const app: *App = @ptrCast(@alignCast(ctx));
        if (app.job) |j| if (j.done.load(.acquire)) {
            app.job = null;
            j.finish();
        };
        app.win.redraw();
        if (app.job != null) nanoui.App.after(100, app, tick) else app.ticking = false;
    }

    pub fn say(app: *App, comptime fmt: []const u8, args: anytype) void {
        app.status = std.fmt.bufPrint(&app.status_buf, fmt, args) catch app.status_buf[0..0];
    }

    pub fn setListing(app: *App, l: *Listing) void {
        if (app.listing) |old| old.free(app.gpa);
        app.listing = l;
        app.search.clear();
        app.refilter();
    }

    fn refilter(app: *App) void {
        app.visible.clearRetainingCapacity();
        app.selected = null;
        const l = app.listing orelse return;
        const q = app.search.text();
        for (l.entries, 0..) |e, i| {
            if (q.len == 0 or std.ascii.findIgnoreCase(e.key[l.prefix.len..], q) != null)
                app.visible.append(app.gpa, @intCast(i)) catch return;
        }
    }

    pub fn start(app: *App, kind: Kind, prefix: []const u8) void {
        if (app.busy.load(.acquire)) return;
        const job = app.gpa.create(Job) catch return;
        job.* = .{ .app = app, .kind = kind, .arena = .init(app.gpa), .cfg = undefined, .prefix = undefined, .session = app.session };
        const a = job.arena.allocator();
        job.prefix = a.dupe(u8, prefix) catch return app.gpa.destroy(job);
        job.cfg = .{
            .endpoint = a.dupe(u8, app.endpoint.text()) catch return,
            .bucket = a.dupe(u8, app.bucket.text()) catch return,
            .access_key = a.dupe(u8, app.access.text()) catch return,
            .secret_key = a.dupe(u8, app.secret.text()) catch return,
        };
        switch (kind) {
            .upload => |p| job.kind = .{ .upload = a.dupe(u8, p) catch return },
            else => {},
        }
        app.progress.reset(0);
        app.setBusy(true);
        app.say("{s}", .{switch (kind) {
            .connect => "Connecting…",
            .list => "Loading files…",
            .upload => "Checking file…",
        }});
        job.thread = std.Thread.spawn(.{}, Job.run, .{job}) catch {
            app.setBusy(false);
            app.say("Could not start the task.", .{});
            return;
        };
        app.job = job;
    }

    fn openFolder(app: *App, prefix: []const u8) void {
        app.start(.list, prefix);
    }

    fn goUp(app: *App) void {
        const l = app.listing orelse return;
        const trimmed = std.mem.trimEnd(u8, l.prefix, "/");
        const cut = std.mem.lastIndexOfScalar(u8, trimmed, '/');
        app.openFolder(if (cut) |i| trimmed[0 .. i + 1] else "");
    }

    fn chooseUpload(app: *App) void {
        const paths = nanoui.dialog.open(app.gpa, .{ .title = "Upload a file", .button = "Upload" }) catch return orelse return;
        defer nanoui.dialog.freePaths(app.gpa, paths);
        if (paths.len == 0) return;
        const prefix = if (app.listing) |l| l.prefix else "";
        app.start(.{ .upload = paths[0] }, prefix);
    }

    fn changeStorage(app: *App) void {
        if (app.busy.load(.acquire)) return;
        if (app.listing) |l| l.free(app.gpa);
        if (app.session) |s| s.close(app.gpa);
        app.listing = null;
        app.session = null;
        app.visible.clearRetainingCapacity();
        app.selected = null;
        app.secret.clear();
        app.say("Connect to your storage to browse files.", .{});
    }

    // ---- view ----

    pub fn view(app: *App, c: *ui.Context) void {
        const th = c.theme;
        const col = ui.div(c).column().sizeFull().p(24).gap(14);
        defer col.end();
        {
            const head = ui.div(c).row().itemsCenter().gap(14);
            defer head.end();
            ui.text(c, "Lopload", .{ .size = 26, .weight = .bold });
            ui.text(c, "Native storage manager · nanoui", .{ .color = th.muted });
        }
        if (app.session == null) app.connectForm(c) else app.browser(c);
        ui.text(c, app.status, .{ .color = th.muted });
        if (app.busy.load(.acquire)) app.progressRow(c);
    }

    fn field(c: *ui.Context, label: []const u8, buf: *ui.TextBuffer, opts: ui.TextFieldOptions) void {
        const group = ui.div(c).column().gap(6);
        defer group.end();
        ui.label(c, label);
        _ = ui.textField(c, buf, opts);
    }

    fn connectForm(app: *App, c: *ui.Context) void {
        const busy = app.busy.load(.acquire);
        if (app.endpoint.len == 0 and !app.endpoint_seeded) {
            app.endpoint.set(default_endpoint);
            app.endpoint_seeded = true;
        }
        ui.text(c, "Connect to S3 storage", .{ .size = 18, .weight = .bold });
        field(c, "Storage address", &app.endpoint, .{ .width = .{ .px = 480 }, .placeholder = "https://storage.example.com" });
        field(c, "Storage name", &app.bucket, .{ .width = .{ .px = 480 }, .placeholder = "my-storage" });
        field(c, "Access ID", &app.access, .{ .width = .{ .px = 480 }, .placeholder = "AKIAIOSFODNN7EXAMPLE" });
        field(c, "Secret", &app.secret, .{ .width = .{ .px = 480 }, .password = true, .placeholder = "Secret access key" });
        if (ui.button(c, "Connect", .{ .variant = .primary, .disabled = busy }).clicked) app.start(.connect, "");
    }

    fn browser(app: *App, c: *ui.Context) void {
        const th = c.theme;
        const busy = app.busy.load(.acquire);
        const l = app.listing;
        const prefix = if (l) |x| x.prefix else "";
        ui.text(c, c.print("{s} / {s}", .{ app.session.?.client.cfg.bucket, prefix }), .{ .size = 18, .weight = .bold });
        {
            const bar = ui.div(c).row().gap(10).itemsCenter();
            defer bar.end();
            if (ui.button(c, "Up", .{ .disabled = busy or prefix.len == 0 }).clicked) app.goUp();
            if (ui.button(c, "Refresh", .{ .disabled = busy }).clicked) app.openFolder(prefix);
            if (ui.button(c, "Upload a file…", .{ .variant = .primary, .disabled = busy }).clicked) app.chooseUpload();
            if (ui.button(c, "Change storage", .{ .disabled = busy }).clicked) return app.changeStorage();
            ui.spacer(c);
            ui.icon(c, "magnifyingglass", .{ .color = th.muted });
            const r = ui.textField(c, &app.search, .{ .placeholder = "Search files", .width = .{ .px = 260 } });
            if (r.changed) app.refilter();
        }
        {
            const hdr = ui.div(c).row().wFull().px(12).gap(10);
            defer hdr.end();
            ui.text(c, "Name", .{ .color = th.muted });
            ui.spacer(c);
            const sz = ui.div(c).w(110);
            defer sz.end();
            ui.text(c, "Size", .{ .color = th.muted });
        }
        const entries: []const s3.Entry = if (l) |x| x.entries else &.{};
        if (app.visible.items.len == 0) ui.text(c, "No files here.", .{ .color = th.muted });

        // Keyboard: arrows are offered as shortcuts; plain Enter arrives as a key when no field has focus.
        const n = app.visible.items.len;
        if (n > 0) {
            if (c.shortcut(.{ .key = ui.Shortcut.down })) app.moveSelection(1);
            if (c.shortcut(.{ .key = ui.Shortcut.up })) app.moveSelection(-1);
            if (!busy and c.input.key == .enter) app.openSelected();
        }

        var rows = ui.list(c, .{ .count = n, .row_height = row_h, .scroll_to = app.scroll_to });
        app.scroll_to = null;
        while (rows.next()) |i| {
            const e = entries[app.visible.items[i]];
            const is_sel = app.selected == i;
            const row = ui.div(c).row().wFull().h(row_h).px(12).gap(10).itemsCenter().rounded(6);
            defer row.end();
            if (is_sel) _ = row.bg(th.accent.alpha(0.2)) else _ = row.hover(th.surface_hover);
            const it = c.interact(row.index, .{});
            if (it.clicked) {
                c.changed = true;
                app.selected = i;
            }
            if (it.double_clicked and e.folder and !busy) app.openFolder(e.key);
            ui.icon(c, if (e.folder) "folder.fill" else "doc", .{ .size = 13, .frame = 18, .color = if (e.folder) th.accent else th.muted });
            ui.text(c, if (e.folder) std.mem.trimEnd(u8, e.key[prefix.len..], "/") else e.key[prefix.len..], .{});
            ui.spacer(c);
            const sz = ui.div(c).w(110);
            defer sz.end();
            if (!e.folder) ui.text(c, formatBytes(c, e.size), .{ .color = th.muted, .mono = true, .size = 12 }) else ui.text(c, "—", .{ .color = th.muted });
        }
        rows.end();
        ui.text(c, c.print("{d} {s}", .{ n, if (n == 1) "item" else "items" }), .{ .color = th.muted });
    }

    fn moveSelection(app: *App, delta: i32) void {
        const n: i64 = @intCast(app.visible.items.len);
        const cur: i64 = if (app.selected) |s| @intCast(s) else if (delta > 0) -1 else n;
        const next: usize = @intCast(std.math.clamp(cur + delta, 0, n - 1));
        app.selected = next;
        app.scroll_to = @max(0, @as(f32, @floatFromInt(next)) * row_h - 160);
    }

    fn openSelected(app: *App) void {
        const sel = app.selected orelse return;
        const l = app.listing orelse return;
        const e = l.entries[app.visible.items[sel]];
        if (e.folder) app.openFolder(e.key);
    }

    fn progressRow(app: *App, c: *ui.Context) void {
        const p = &app.progress;
        const phase = p.phase.load(.monotonic);
        const done = p.done.load(.monotonic);
        const total = p.total.load(.monotonic);
        if (phase != .idle) {
            app.say("{s}", .{switch (phase) {
                .hashing => "Checking file…",
                .uploading => "Uploading…",
                .verifying => "Verifying file…",
                else => "Working…",
            }});
        }
        const r = ui.div(c).row().gap(12).itemsCenter();
        defer r.end();
        const ref: u64 = if (phase == .hashing or phase == .idle) 0 else total;
        const frac: f32 = if (ref > 0) @floatCast(@as(f64, @floatFromInt(done)) / @as(f64, @floatFromInt(ref))) else 0;
        ui.progress(c, frac, .fill);
        if (ref > 0) ui.text(c, c.print("{s} / {s}", .{ formatBytes(c, @intCast(done)), formatBytes(c, @intCast(ref)) }), .{ .mono = true, .size = 12 });
        if (ui.button(c, "Cancel", .{}).clicked) app.progress.cancel.store(true, .monotonic);
    }
};

fn formatBytes(c: *ui.Context, n: i64) []const u8 {
    const f: f64 = @floatFromInt(n);
    if (n < 1024) return c.print("{d} B", .{n});
    if (n < 1 << 20) return c.print("{d:.1} KB", .{f / 1024});
    if (n < 1 << 30) return c.print("{d:.1} MB", .{f / (1 << 20)});
    return c.print("{d:.2} GB", .{f / (1 << 30)});
}

pub fn main(init: std.process.Init) !void {
    const nano = try nanoui.App.create(init, .{ .name = "Lopload" });
    defer nano.destroy();
    var app: App = .{ .gpa = init.gpa, .io = init.io, .nano = nano };
    var mode: enum { normal, benchmark, demo } = .normal;
    var it = try std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa);
    defer it.deinit();
    while (it.next()) |arg| {
        if (std.mem.eql(u8, arg, "--benchmark")) mode = .benchmark;
        if (std.mem.eql(u8, arg, "--demo")) mode = .demo;
    }
    app.win = try nano.newWindow(.{
        .title = "Lopload · Native nanoui",
        .width = 1000,
        .height = 720,
        .min_width = 700,
        .min_height = 560,
        .content = .{ .view = .init(&app, App.view) },
    });
    if (mode != .normal and builtin.os.tag == .macos) {
        const t = try std.Thread.spawn(.{}, @import("bench.zig").run, .{ &app, mode == .demo });
        t.detach();
    }
    try nano.run();
}
