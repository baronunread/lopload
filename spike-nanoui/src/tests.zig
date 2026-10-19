//! Tests against the real MinIO on 127.0.0.1:9400 (the repository's test container).
//! Every test owns a fresh bucket. There are no doubles for storage or the HTTP stack.
const std = @import("std");
const s3 = @import("s3");
const Sha256 = std.crypto.hash.sha2.Sha256;

const gpa = std.testing.allocator;
const io = std.testing.io;

const Fixture = struct {
    client: s3.Client,
    arena: std.heap.ArenaAllocator,

    fn init(name: []const u8) !*Fixture {
        const f = try gpa.create(Fixture);
        errdefer gpa.destroy(f);
        f.arena = .init(gpa);
        errdefer f.arena.deinit();
        const now = std.Io.Clock.real.now(io).nanoseconds;
        const bucket = try std.fmt.allocPrint(f.arena.allocator(), "nanoui-{s}-{x}", .{ name, @as(u64, @truncate(@as(u96, @bitCast(now)))) });
        f.client = try s3.Client.init(gpa, io, .{ .endpoint = "http://127.0.0.1:9400", .bucket = bucket, .access_key = "minioadmin", .secret_key = "minioadmin" });
        try f.client.makeBucket(f.arena.allocator());
        return f;
    }

    fn deinit(f: *Fixture) void {
        f.client.purge(f.arena.allocator()) catch {};
        f.client.deinit();
        f.arena.deinit();
        gpa.destroy(f);
    }
};

fn writeTemp(name: []const u8, size: usize, seed: u8) !void {
    const data = try gpa.alloc(u8, size);
    defer gpa.free(data);
    var prng = std.Random.DefaultPrng.init(seed);
    prng.random().bytes(data);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = name, .data = data });
}

fn sha(data: []const u8) [32]u8 {
    var h: [32]u8 = undefined;
    Sha256.hash(data, &h, .{});
    return h;
}

test "signed requests are accepted and a wrong secret is refused" {
    const f = try Fixture.init("auth");
    defer f.deinit();
    const a = f.arena.allocator();
    try f.client.putBytes(a, "hello.txt", "hello");
    const back = try f.client.getBytes(a, "hello.txt");
    try std.testing.expectEqualStrings("hello", back);

    var bad = try s3.Client.init(gpa, io, .{ .endpoint = "http://127.0.0.1:9400", .bucket = f.client.cfg.bucket, .access_key = "minioadmin", .secret_key = "wrong" });
    defer bad.deinit();
    try std.testing.expectError(s3.Error.HttpStatus, bad.list(a, ""));
    try std.testing.expectEqual(@as(u16, 403), bad.last_status);
}

test "listing returns folders first, files with sizes, and honours prefixes" {
    const f = try Fixture.init("list");
    defer f.deinit();
    const a = f.arena.allocator();
    try f.client.putBytes(a, "b.txt", "bb");
    try f.client.putBytes(a, "a.txt", "a");
    try f.client.putBytes(a, "docs/one.txt", "1");
    try f.client.putBytes(a, "docs/deep/two.txt", "22");
    try f.client.putBytes(a, "zeta/x", "x");

    const root = try f.client.list(a, "");
    try std.testing.expectEqual(@as(usize, 4), root.len);
    try std.testing.expect(root[0].folder and std.mem.eql(u8, root[0].key, "docs/"));
    try std.testing.expect(root[1].folder and std.mem.eql(u8, root[1].key, "zeta/"));
    try std.testing.expectEqualStrings("a.txt", root[2].key);
    try std.testing.expectEqual(@as(i64, 1), root[2].size);
    try std.testing.expectEqual(@as(i64, 2), root[3].size);

    const docs = try f.client.list(a, "docs/");
    try std.testing.expectEqual(@as(usize, 2), docs.len);
    try std.testing.expectEqualStrings("docs/deep/", docs[0].key);
    try std.testing.expectEqualStrings("docs/one.txt", docs[1].key);
}

test "keys with spaces, unicode and XML characters sign, store and list correctly" {
    const f = try Fixture.init("keys");
    defer f.deinit();
    const a = f.arena.allocator();
    const keys = [_][]const u8{ "my folder/été & co <1>.txt", "plus+sign=eq~tilde.txt", "日本語/ファイル.txt" };
    for (keys) |k| try f.client.putBytes(a, k, k);
    for (keys) |k| try std.testing.expectEqualStrings(k, try f.client.getBytes(a, k));
    const root = try f.client.list(a, "");
    try std.testing.expectEqual(@as(usize, 3), root.len);
    const nested = try f.client.list(a, "my folder/");
    try std.testing.expectEqual(@as(usize, 1), nested.len);
    try std.testing.expectEqualStrings(keys[0], nested[0].key);
}

test "listing follows continuation tokens past 1000 keys" {
    const f = try Fixture.init("page");
    defer f.deinit();
    const a = f.arena.allocator();
    for (0..1105) |i| try f.client.putBytes(a, try std.fmt.allocPrint(a, "d/f-{d:0>4}.txt", .{i}), "");
    const entries = try f.client.list(a, "d/");
    try std.testing.expectEqual(@as(usize, 1105), entries.len);
}

test "uploaded bytes match what a separate read returns" {
    const f = try Fixture.init("upload");
    defer f.deinit();
    const a = f.arena.allocator();
    const path = ".zig-cache/nanoui-test-upload.bin";
    try writeTemp(path, 12 * 1024 * 1024 + 123, 7);
    defer std.Io.Dir.cwd().deleteFile(io, path) catch {};
    var p: s3.Progress = .{};
    try f.client.uploadVerified(a, path, "big/file.bin", &p);
    try std.testing.expectEqual(s3.Progress.Phase.done, p.phase.load(.monotonic));

    const original = try std.Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited);
    const stored = try f.client.getBytes(a, "big/file.bin");
    try std.testing.expectEqual(original.len, stored.len);
    try std.testing.expectEqualSlices(u8, &sha(original), &sha(stored));
    const listed = try f.client.list(a, "big/");
    try std.testing.expectEqual(@as(i64, @intCast(original.len)), listed[0].size);
}

test "an existing destination is refused and left untouched" {
    const f = try Fixture.init("exists");
    defer f.deinit();
    const a = f.arena.allocator();
    const path = ".zig-cache/nanoui-test-exists.bin";
    try writeTemp(path, 1024, 1);
    defer std.Io.Dir.cwd().deleteFile(io, path) catch {};
    try f.client.putBytes(a, "x.bin", "original");
    var p: s3.Progress = .{};
    try std.testing.expectError(s3.Error.Exists, f.client.uploadVerified(a, path, "x.bin", &p));
    try std.testing.expectEqualStrings("original", try f.client.getBytes(a, "x.bin"));
}

test "verification fails when the stored bytes differ from the local file" {
    const f = try Fixture.init("corrupt");
    defer f.deinit();
    const a = f.arena.allocator();
    var data: [4096]u8 = undefined;
    @memset(&data, 'a');
    const expected = sha(&data);
    data[2000] ^= 1; // one flipped bit in what the server holds
    try f.client.putBytes(a, "c.bin", &data);
    var p: s3.Progress = .{};
    try std.testing.expectError(s3.Error.VerificationFailed, f.client.verify(a, "c.bin", data.len, expected, &p));
}

test "canceling before the transfer stores nothing" {
    const f = try Fixture.init("cancel0");
    defer f.deinit();
    const a = f.arena.allocator();
    const path = ".zig-cache/nanoui-test-cancel0.bin";
    try writeTemp(path, 4 * 1024 * 1024, 3);
    defer std.Io.Dir.cwd().deleteFile(io, path) catch {};
    var p: s3.Progress = .{};
    p.cancel.store(true, .monotonic);
    try std.testing.expectError(s3.Error.Canceled, f.client.uploadVerified(a, path, "c.bin", &p));
    try std.testing.expectEqual(@as(?u64, null), try f.client.head(a, "c.bin"));
}

test "canceling during the upload stores no object and the client stays usable" {
    const f = try Fixture.init("cancel1");
    defer f.deinit();
    const a = f.arena.allocator();
    const path = ".zig-cache/nanoui-test-cancel1.bin";
    try writeTemp(path, 256 * 1024 * 1024, 5);
    defer std.Io.Dir.cwd().deleteFile(io, path) catch {};
    var p: s3.Progress = .{};
    const T = struct {
        fn run(pp: *s3.Progress) void {
            while (pp.phase.load(.monotonic) != .uploading or pp.done.load(.monotonic) < 8 * 1024 * 1024) std.atomic.spinLoopHint();
            pp.cancel.store(true, .monotonic);
        }
    };
    const t = try std.Thread.spawn(.{}, T.run, .{&p});
    defer t.join();
    try std.testing.expectError(s3.Error.Canceled, f.client.uploadVerified(a, path, "c.bin", &p));
    try std.testing.expectEqual(@as(?u64, null), try f.client.head(a, "c.bin"));
    try f.client.putBytes(a, "after.txt", "still works");
    try std.testing.expectEqualStrings("still works", try f.client.getBytes(a, "after.txt"));
}

// ---- the native view over real storage ----

const ui = @import("nanoui").ui;
const app_mod = @import("main.zig");

test "native view: virtualized list over real listings, search, and keyboard selection" {
    const f = try Fixture.init("view");
    defer f.deinit();
    const a = f.arena.allocator();
    for (0..2500) |i| try f.client.putBytes(a, try std.fmt.allocPrint(a, "documents/file-{d:0>4}.txt", .{i}), "");
    try f.client.putBytes(a, "documents/reports/q1.txt", "x");

    var app: app_mod.App = .{ .gpa = gpa, .io = io, .nano = undefined };
    defer {
        if (app.listing) |l| l.free(gpa);
        if (app.session) |s| s.close(gpa);
        app.visible.deinit(gpa);
    }
    app.session = try app_mod.Session.open(gpa, io, f.client.cfg);
    app.setListing(try app_mod.Listing.load(gpa, &app.session.?.client, "documents/"));
    try std.testing.expectEqual(@as(usize, 2501), app.visible.items.len);

    var t: ui.Tester = undefined;
    try t.init(gpa, .init(&app, app_mod.App.view), .{ .width = 1000, .height = 720 });
    defer t.deinit();

    // Folders sort first, and only the rows in view are built out of 2,501.
    try std.testing.expect(t.hasText("reports"));
    try std.testing.expect(t.hasText("file-0000.txt"));
    try std.testing.expect(!t.hasText("file-2000.txt"));
    try std.testing.expect(t.ctx.nodes.items.len < 400);
    try std.testing.expect(t.containsText("2501 items"));

    // Arrow keys are offered as shortcuts; three downs select the third row.
    try std.testing.expect(t.shortcut(.{ .key = ui.Shortcut.down }));
    try std.testing.expect(t.shortcut(.{ .key = ui.Shortcut.down }));
    try std.testing.expect(t.shortcut(.{ .key = ui.Shortcut.down }));
    try std.testing.expectEqual(@as(?usize, 2), app.selected);
    try std.testing.expect(t.shortcut(.{ .key = ui.Shortcut.up }));
    try std.testing.expectEqual(@as(?usize, 1), app.selected);

    // Typing in the search field narrows the real listing.
    try t.clickText("Search files");
    t.typeText("1999");
    try std.testing.expect(t.hasText("file-1999.txt"));
    try std.testing.expect(!t.hasText("file-0000.txt"));
    try std.testing.expectEqual(@as(usize, 1), app.visible.items.len);
    try std.testing.expect(t.containsText("1 item"));
}
