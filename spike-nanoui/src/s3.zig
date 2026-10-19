//! A small S3 client on Zig's standard library: SigV4 signing, ListObjectsV2,
//! streaming PUT with progress and cancellation, and SHA-256 readback.
//! Path-style addressing, so it works with MinIO and most S3-compatible stores.
const std = @import("std");
const http = std.http;
const Hmac = std.crypto.auth.hmac.sha2.HmacSha256;
const Sha256 = std.crypto.hash.sha2.Sha256;

pub const Config = struct {
    /// `http://host:port` or `https://host`, without a path.
    endpoint: []const u8,
    bucket: []const u8,
    access_key: []const u8,
    secret_key: []const u8,
    region: []const u8 = "us-east-1",
};

pub const Entry = struct {
    key: []const u8,
    size: i64,
    folder: bool,
};

/// Shared between the worker doing a transfer and the UI that shows it.
pub const Progress = struct {
    pub const Phase = enum(u8) { idle, hashing, uploading, verifying, done };
    phase: std.atomic.Value(Phase) = .init(.idle),
    done: std.atomic.Value(u64) = .init(0),
    total: std.atomic.Value(u64) = .init(0),
    cancel: std.atomic.Value(bool) = .init(false),

    pub fn reset(p: *Progress, total: u64) void {
        p.cancel.store(false, .monotonic);
        p.done.store(0, .monotonic);
        p.total.store(total, .monotonic);
        p.phase.store(.idle, .monotonic);
    }
};

pub const Error = error{
    HttpStatus,
    Exists,
    Canceled,
    VerificationFailed,
    BadResponse,
    BadEndpoint,
};

pub const Client = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    cfg: Config,
    http: http.Client,
    host: []const u8,
    /// The last unexpected HTTP status, for diagnostics.
    last_status: u16 = 0,

    pub fn init(gpa: std.mem.Allocator, io: std.Io, cfg: Config) !Client {
        const scheme_end = std.mem.indexOf(u8, cfg.endpoint, "://") orelse return Error.BadEndpoint;
        const host = std.mem.trimEnd(u8, cfg.endpoint[scheme_end + 3 ..], "/");
        if (host.len == 0) return Error.BadEndpoint;
        return .{ .gpa = gpa, .io = io, .cfg = cfg, .http = .{ .allocator = gpa, .io = io }, .host = host };
    }

    pub fn deinit(c: *Client) void {
        c.http.deinit();
    }

    // ---- signing ----

    const Signed = struct {
        authorization: []const u8,
        amz_date: []const u8,
        payload_hash: []const u8,
        url: []const u8,
    };

    fn sign(c: *Client, a: std.mem.Allocator, method: []const u8, key: []const u8, query: []const u8, payload_hash: []const u8) !Signed {
        const now = std.Io.Clock.real.now(c.io);
        const secs: u64 = @intCast(@divFloor(now.nanoseconds, std.time.ns_per_s));
        const es: std.time.epoch.EpochSeconds = .{ .secs = secs };
        const yd = es.getEpochDay().calculateYearDay();
        const md = yd.calculateMonthDay();
        const ds = es.getDaySeconds();
        const date = try std.fmt.allocPrint(a, "{d:0>4}{d:0>2}{d:0>2}", .{ yd.year, md.month.numeric(), md.day_index + 1 });
        const amz_date = try std.fmt.allocPrint(a, "{s}T{d:0>2}{d:0>2}{d:0>2}Z", .{ date, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute() });

        var path: std.Io.Writer.Allocating = .init(a);
        try path.writer.print("/{s}", .{c.cfg.bucket});
        if (key.len > 0) {
            try path.writer.writeByte('/');
            try uriEncode(&path.writer, key, false);
        }
        const canonical = try std.fmt.allocPrint(a, "{s}\n{s}\n{s}\nhost:{s}\nx-amz-content-sha256:{s}\nx-amz-date:{s}\n\nhost;x-amz-content-sha256;x-amz-date\n{s}", .{
            method, path.written(), query, c.host, payload_hash, amz_date, payload_hash,
        });
        var canon_hash: [32]u8 = undefined;
        Sha256.hash(canonical, &canon_hash, .{});
        const scope = try std.fmt.allocPrint(a, "{s}/{s}/s3/aws4_request", .{ date, c.cfg.region });
        const to_sign = try std.fmt.allocPrint(a, "AWS4-HMAC-SHA256\n{s}\n{s}\n{x}", .{ amz_date, scope, canon_hash });

        var k: [32]u8 = undefined;
        const seed = try std.fmt.allocPrint(a, "AWS4{s}", .{c.cfg.secret_key});
        Hmac.create(&k, date, seed);
        Hmac.create(&k, c.cfg.region, &k);
        Hmac.create(&k, "s3", &k);
        Hmac.create(&k, "aws4_request", &k);
        var sig: [32]u8 = undefined;
        Hmac.create(&sig, to_sign, &k);

        const auth = try std.fmt.allocPrint(a, "AWS4-HMAC-SHA256 Credential={s}/{s}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={x}", .{ c.cfg.access_key, scope, sig });
        const url = try std.fmt.allocPrint(a, "{s}{s}{s}{s}", .{ std.mem.trimEnd(u8, c.cfg.endpoint, "/"), path.written(), if (query.len > 0) "?" else "", query });
        return .{ .authorization = auth, .amz_date = amz_date, .payload_hash = payload_hash, .url = url };
    }

    const empty_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const unsigned = "UNSIGNED-PAYLOAD";

    fn begin(c: *Client, a: std.mem.Allocator, method: http.Method, key: []const u8, query: []const u8, payload_hash: []const u8, content_length: ?u64) !http.Client.Request {
        const s = try c.sign(a, @tagName(method), key, query, payload_hash);
        const headers = try a.dupe(http.Header, &.{
            .{ .name = "x-amz-content-sha256", .value = s.payload_hash },
            .{ .name = "x-amz-date", .value = s.amz_date },
        });
        var req = try c.http.request(method, try std.Uri.parse(s.url), .{
            .headers = .{ .authorization = .{ .override = s.authorization }, .accept_encoding = .omit },
            .extra_headers = headers,
            .redirect_behavior = .unhandled,
        });
        if (content_length) |n| req.transfer_encoding = .{ .content_length = n };
        return req;
    }

    /// One request with an optional in-memory body; returns the status and the body in `a`.
    fn simple(c: *Client, a: std.mem.Allocator, method: http.Method, key: []const u8, query: []const u8, payload: ?[]const u8) !struct { status: http.Status, body: []u8 } {
        var hash_buf: [64]u8 = undefined;
        const ph = if (payload) |p| blk: {
            var h: [32]u8 = undefined;
            Sha256.hash(p, &h, .{});
            break :blk try std.fmt.bufPrint(&hash_buf, "{x}", .{h});
        } else empty_hash;
        var req = try c.begin(a, method, key, query, ph, if (payload) |p| p.len else null);
        defer req.deinit();
        if (payload) |p| {
            var body = try req.sendBodyUnflushed(&.{});
            try body.writer.writeAll(p);
            try body.end();
            try req.connection.?.flush();
        } else try req.sendBodiless();
        var response = try req.receiveHead(&.{});
        const status = response.head.status;
        // std ends these responses at the head but Request.deinit would still wait for a body that
        // never comes; closing the connection (cheap on a local or pooled link) avoids a 30 s stall.
        if (status == .no_content or status == .not_modified) {
            req.connection.?.closing = true;
            return .{ .status = status, .body = &.{} };
        }
        var tbuf: [4096]u8 = undefined;
        const reader = response.reader(&tbuf);
        const body = reader.allocRemaining(a, .limited(64 << 20)) catch |e| switch (e) {
            error.ReadFailed => return response.bodyErr().?,
            else => return e,
        };
        return .{ .status = status, .body = body };
    }

    fn expect(c: *Client, status: http.Status, ok: []const http.Status) !void {
        for (ok) |s| if (s == status) return;
        c.last_status = @intFromEnum(status);
        return Error.HttpStatus;
    }

    // ---- operations ----

    /// The folders and files directly under `prefix` (empty or ending in `/`), folders first.
    /// Strings live in `a`.
    pub fn list(c: *Client, a: std.mem.Allocator, prefix: []const u8) ![]Entry {
        var out: std.ArrayList(Entry) = .empty;
        var token: ?[]const u8 = null;
        while (true) {
            var q: std.Io.Writer.Allocating = .init(a);
            if (token) |t| {
                try q.writer.writeAll("continuation-token=");
                try uriEncode(&q.writer, t, true);
                try q.writer.writeByte('&');
            }
            try q.writer.writeAll("delimiter=%2F&list-type=2&prefix=");
            try uriEncode(&q.writer, prefix, true);
            const r = try c.simple(a, .GET, "", q.written(), null);
            try c.expect(r.status, &.{.ok});
            token = try parseList(a, r.body, prefix, &out);
            if (token == null) break;
        }
        std.mem.sort(Entry, out.items, {}, entryLess);
        return out.items;
    }

    fn entryLess(_: void, x: Entry, y: Entry) bool {
        if (x.folder != y.folder) return x.folder;
        return std.ascii.lessThanIgnoreCase(x.key, y.key);
    }

    /// Returns the next continuation token, if the listing is truncated.
    fn parseList(a: std.mem.Allocator, xml: []const u8, prefix: []const u8, out: *std.ArrayList(Entry)) !?[]const u8 {
        var rest = xml;
        while (tag(rest, "Contents")) |block| {
            rest = rest[block.end..];
            const key = tag(block.inner, "Key") orelse return Error.BadResponse;
            const size = tag(block.inner, "Size") orelse return Error.BadResponse;
            const k = try unescape(a, key.inner);
            if (std.mem.eql(u8, k, prefix)) continue; // the folder's own marker
            try out.append(a, .{ .key = k, .size = std.fmt.parseInt(i64, size.inner, 10) catch return Error.BadResponse, .folder = false });
        }
        rest = xml;
        while (tag(rest, "CommonPrefixes")) |block| {
            rest = rest[block.end..];
            const p = tag(block.inner, "Prefix") orelse return Error.BadResponse;
            try out.append(a, .{ .key = try unescape(a, p.inner), .size = -1, .folder = true });
        }
        const truncated = tag(xml, "IsTruncated") orelse return null;
        if (!std.mem.eql(u8, truncated.inner, "true")) return null;
        const next = tag(xml, "NextContinuationToken") orelse return Error.BadResponse;
        return try unescape(a, next.inner);
    }

    const Tag = struct { inner: []const u8, end: usize };
    fn tag(s: []const u8, name: []const u8) ?Tag {
        var open_buf: [32]u8 = undefined;
        var close_buf: [32]u8 = undefined;
        const open = std.fmt.bufPrint(&open_buf, "<{s}>", .{name}) catch return null;
        const close = std.fmt.bufPrint(&close_buf, "</{s}>", .{name}) catch return null;
        const i = std.mem.indexOf(u8, s, open) orelse return null;
        const j = std.mem.indexOfPos(u8, s, i + open.len, close) orelse return null;
        return .{ .inner = s[i + open.len .. j], .end = j + close.len };
    }

    fn unescape(a: std.mem.Allocator, s: []const u8) ![]const u8 {
        if (std.mem.indexOfScalar(u8, s, '&') == null) return a.dupe(u8, s);
        const table = [_][2][]const u8{ .{ "&amp;", "&" }, .{ "&lt;", "<" }, .{ "&gt;", ">" }, .{ "&quot;", "\"" }, .{ "&apos;", "'" } };
        var out: std.ArrayList(u8) = .empty;
        var i: usize = 0;
        outer: while (i < s.len) {
            for (table) |t| {
                if (std.mem.startsWith(u8, s[i..], t[0])) {
                    try out.appendSlice(a, t[1]);
                    i += t[0].len;
                    continue :outer;
                }
            }
            try out.append(a, s[i]);
            i += 1;
        }
        return out.items;
    }

    /// Size of an object, or null if it does not exist.
    pub fn head(c: *Client, a: std.mem.Allocator, key: []const u8) !?u64 {
        var req = try c.begin(a, .HEAD, key, "", empty_hash, null);
        defer req.deinit();
        try req.sendBodiless();
        const response = try req.receiveHead(&.{});
        if (response.head.status == .not_found) return null;
        try c.expect(response.head.status, &.{.ok});
        return response.head.content_length orelse 0;
    }

    pub fn putBytes(c: *Client, a: std.mem.Allocator, key: []const u8, data: []const u8) !void {
        const r = try c.simple(a, .PUT, key, "", data);
        try c.expect(r.status, &.{.ok});
    }

    pub fn delete(c: *Client, a: std.mem.Allocator, key: []const u8) !void {
        const r = try c.simple(a, .DELETE, key, "", null);
        try c.expect(r.status, &.{ .no_content, .ok });
    }

    pub fn makeBucket(c: *Client, a: std.mem.Allocator) !void {
        const r = try c.simple(a, .PUT, "", "", "");
        try c.expect(r.status, &.{ .ok, .conflict });
    }

    pub fn removeBucket(c: *Client, a: std.mem.Allocator) !void {
        const r = try c.simple(a, .DELETE, "", "", null);
        try c.expect(r.status, &.{ .no_content, .ok });
    }

    /// Deletes every object (at any depth) and then the bucket. For tests and the benchmark fixture.
    pub fn purge(c: *Client, a: std.mem.Allocator) !void {
        var stack: std.ArrayList([]const u8) = .empty;
        try stack.append(a, "");
        while (stack.pop()) |prefix| {
            for (try c.list(a, prefix)) |e| {
                if (e.folder) try stack.append(a, e.key) else try c.delete(a, e.key);
            }
        }
        try c.removeBucket(a);
    }

    /// Whole object into memory; for small objects and tests.
    pub fn getBytes(c: *Client, a: std.mem.Allocator, key: []const u8) ![]u8 {
        const r = try c.simple(a, .GET, key, "", null);
        try c.expect(r.status, &.{.ok});
        return r.body;
    }

    // ---- verified upload ----

    const chunk_len = 256 * 1024;

    /// SHA-256 of a local file, in 256 KiB reads. Updates `p.done` as it goes.
    pub fn hashFile(c: *Client, path: []const u8, p: *Progress) !struct { sha: [32]u8, size: u64 } {
        var file = try openPath(c.io, path);
        defer file.close(c.io);
        const buf = try c.gpa.alloc(u8, chunk_len);
        defer c.gpa.free(buf);
        var rbuf: [4096]u8 = undefined;
        var fr = file.reader(c.io, &rbuf);
        var h = Sha256.init(.{});
        var size: u64 = 0;
        while (true) {
            if (p.cancel.load(.monotonic)) return Error.Canceled;
            const n = try fr.interface.readSliceShort(buf);
            if (n == 0) break;
            h.update(buf[0..n]);
            size += n;
            p.done.store(size, .monotonic);
            if (n < buf.len) break;
        }
        return .{ .sha = h.finalResult(), .size = size };
    }

    fn openPath(io: std.Io, path: []const u8) !std.Io.File {
        if (std.fs.path.isAbsolute(path)) return std.Io.Dir.openFileAbsolute(io, path, .{});
        return std.Io.Dir.cwd().openFile(io, path, .{});
    }

    /// Streams a local file to `key`. The body is sent as UNSIGNED-PAYLOAD, as the S3 spec allows.
    pub fn putFile(c: *Client, a: std.mem.Allocator, path: []const u8, key: []const u8, size: u64, p: *Progress) !void {
        var file = try openPath(c.io, path);
        defer file.close(c.io);
        const buf = try c.gpa.alloc(u8, chunk_len);
        defer c.gpa.free(buf);
        var rbuf: [4096]u8 = undefined;
        var fr = file.reader(c.io, &rbuf);

        var req = try c.begin(a, .PUT, key, "", unsigned, size);
        defer req.deinit();
        var body = try req.sendBodyUnflushed(&.{});
        var sent: u64 = 0;
        while (sent < size) {
            if (p.cancel.load(.monotonic)) {
                req.connection.?.closing = true;
                return Error.Canceled;
            }
            const want: usize = @intCast(@min(buf.len, size - sent));
            try fr.interface.readSliceAll(buf[0..want]);
            try body.writer.writeAll(buf[0..want]);
            sent += want;
            p.done.store(sent, .monotonic);
        }
        try body.end();
        try req.connection.?.flush();
        var response = try req.receiveHead(&.{});
        const status = response.head.status;
        var tbuf: [1024]u8 = undefined;
        _ = response.reader(&tbuf).discardRemaining() catch {};
        try c.expect(status, &.{.ok});
    }

    /// Reads the whole object back and compares its SHA-256 with `expected`.
    pub fn verify(c: *Client, a: std.mem.Allocator, key: []const u8, size: u64, expected: [32]u8, p: *Progress) !void {
        var req = try c.begin(a, .GET, key, "", empty_hash, null);
        defer req.deinit();
        try req.sendBodiless();
        var response = try req.receiveHead(&.{});
        try c.expect(response.head.status, &.{.ok});
        const buf = try c.gpa.alloc(u8, chunk_len);
        defer c.gpa.free(buf);
        var tbuf: [4096]u8 = undefined;
        const reader = response.reader(&tbuf);
        var h = Sha256.init(.{});
        var got: u64 = 0;
        while (true) {
            if (p.cancel.load(.monotonic)) {
                req.connection.?.closing = true;
                return Error.Canceled;
            }
            const n = reader.readSliceShort(buf) catch |e| switch (e) {
                error.ReadFailed => return response.bodyErr().?,
            };
            h.update(buf[0..n]);
            got += n;
            p.done.store(got, .monotonic);
            if (n < buf.len) break;
        }
        if (got != size or !std.mem.eql(u8, &h.finalResult(), &expected)) return Error.VerificationFailed;
    }

    /// Hash, upload, and read back. Refuses to replace an existing object.
    pub fn uploadVerified(c: *Client, a: std.mem.Allocator, path: []const u8, key: []const u8, p: *Progress) !void {
        p.done.store(0, .monotonic);
        p.phase.store(.hashing, .monotonic);
        const hashed = try c.hashFile(path, p);
        if (try c.head(a, key) != null) return Error.Exists;
        p.total.store(hashed.size, .monotonic);
        p.done.store(0, .monotonic);
        p.phase.store(.uploading, .monotonic);
        try c.putFile(a, path, key, hashed.size, p);
        p.done.store(0, .monotonic);
        p.phase.store(.verifying, .monotonic);
        try c.verify(a, key, hashed.size, hashed.sha, p);
        p.phase.store(.done, .monotonic);
    }
};

/// Percent-encodes per SigV4: unreserved characters stay; `/` stays unless `encode_slash`.
pub fn uriEncode(w: *std.Io.Writer, s: []const u8, encode_slash: bool) !void {
    for (s) |ch| {
        const keep = std.ascii.isAlphanumeric(ch) or ch == '-' or ch == '_' or ch == '.' or ch == '~' or (ch == '/' and !encode_slash);
        if (keep) try w.writeByte(ch) else try w.print("%{X:0>2}", .{ch});
    }
}
