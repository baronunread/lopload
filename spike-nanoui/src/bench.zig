//! `--benchmark` and `--demo`: fixtures on the local MinIO, driven through the same app code paths as a user.
//! Benchmark: 1,000 empty files listed, 15 s idle, a 1 GiB upload with SHA-256 readback, 10 s idle, cleanup.
//! Demo: the same listing, left on screen (for `--nanoui-snapshot`); its bucket is not removed.
const std = @import("std");
const nanoui = @import("nanoui");
const objc = nanoui.objc;
const main = @import("main.zig");
const App = main.App;

const endpoint = "http://127.0.0.1:9400";

pub fn run(app: *App, demo: bool) void {
    inner(app, demo) catch |e| std.debug.print("BENCHMARK_FAILED {t}\n", .{e});
    if (!demo) objc.dispatchMain(app.nano, quit);
}

fn quit(ctx: ?*anyopaque) callconv(.c) void {
    const nano: *nanoui.App = @ptrCast(@alignCast(ctx));
    nano.quit();
}

fn sleepSeconds(app: *App, n: i64) void {
    std.Io.sleep(app.io, .fromSeconds(n), .real) catch {};
}

const Install = struct {
    app: *App,
    session: *main.Session,
    listing: *main.Listing,
    done: std.atomic.Value(bool) = .init(false),

    fn apply(ctx: ?*anyopaque) callconv(.c) void {
        const i: *Install = @ptrCast(@alignCast(ctx));
        const app = i.app;
        app.session = i.session;
        app.setListing(i.listing);
        app.say("Benchmark: 1,000 real files.", .{});
        app.win.redraw();
        i.done.store(true, .release);
    }
};

const Begin = struct {
    app: *App,
    path: []const u8,
    done: std.atomic.Value(bool) = .init(false),

    fn apply(ctx: ?*anyopaque) callconv(.c) void {
        const b: *Begin = @ptrCast(@alignCast(ctx));
        b.app.start(.{ .upload = b.path }, "documents/");
        b.done.store(true, .release);
    }
};

fn inner(app: *App, demo: bool) !void {
    const gpa = app.gpa;
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const now: u64 = @truncate(@as(u96, @bitCast(std.Io.Clock.real.now(app.io).nanoseconds)));
    const bucket = if (demo) "nanoui-demo" else try std.fmt.allocPrint(a, "nanoui-bench-{d}", .{now});
    const session = try main.Session.open(gpa, app.io, .{ .endpoint = endpoint, .bucket = bucket, .access_key = "minioadmin", .secret_key = "minioadmin" });
    const client = &session.client;
    try client.makeBucket(a);
    for (0..1000) |i| try client.putBytes(a, try std.fmt.allocPrint(a, "documents/file-{d:0>4}.txt", .{i}), "");
    // A few folders and varied files so the screenshot looks like a real listing.
    if (demo) {
        for ([_][]const u8{ "documents/reports/", "documents/archive/", "documents/photos/" }) |d|
            try client.putBytes(a, try std.fmt.allocPrint(a, "{s}README.txt", .{d}), "x");
    }
    const listing = try main.Listing.load(gpa, client, "documents/");

    var install: Install = .{ .app = app, .session = session, .listing = listing };
    objc.dispatchMain(&install, Install.apply);
    while (!install.done.load(.acquire)) sleepMs(app, 20);
    if (demo) return;

    std.debug.print("BENCHMARK_IDLE\n", .{});
    sleepSeconds(app, 15);

    const path = try std.fmt.allocPrint(a, "/tmp/lopload-nanoui-bench-{d}.bin", .{now});
    {
        const f = try std.Io.Dir.createFileAbsolute(app.io, path, .{});
        defer f.close(app.io);
        try f.setLength(app.io, 1 << 30);
    }
    defer std.Io.Dir.deleteFileAbsolute(app.io, path) catch {};
    defer {
        client.purge(a) catch std.debug.print("BENCHMARK_CLEANUP_FAILED\n", .{});
    }

    const started = std.Io.Clock.real.now(app.io).nanoseconds;
    std.debug.print("BENCHMARK_UPLOAD_START\n", .{});
    var begin: Begin = .{ .app = app, .path = path };
    objc.dispatchMain(&begin, Begin.apply);
    while (!begin.done.load(.acquire)) sleepMs(app, 20);
    while (app.busy.load(.acquire)) sleepMs(app, 100);
    if (!std.mem.startsWith(u8, app.status, "Uploaded ✓")) return error.UploadDidNotVerify;
    const elapsed = std.Io.Clock.real.now(app.io).nanoseconds - started;
    std.debug.print("BENCHMARK_UPLOAD_DONE bytes={d} elapsed_ms={d}\n", .{ 1 << 30, @divFloor(elapsed, std.time.ns_per_ms) });
    sleepSeconds(app, 10);
    std.debug.print("BENCHMARK_DONE\n", .{});
}

fn sleepMs(app: *App, n: i64) void {
    std.Io.sleep(app.io, .fromMilliseconds(n), .real) catch {};
}
