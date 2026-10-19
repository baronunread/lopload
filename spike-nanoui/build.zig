const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const nanoui = b.dependency("nanoui", .{ .target = target, .optimize = optimize }).module("nanoui");

    const s3 = b.createModule(.{ .root_source_file = b.path("src/s3.zig"), .target = target, .optimize = optimize });
    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "nanoui", .module = nanoui }, .{ .name = "s3", .module = s3 } },
    });
    const exe = b.addExecutable(.{ .name = "lopload-nanoui", .root_module = root });
    // No console window behind the app on Windows.
    if (target.result.os.tag == .windows) exe.subsystem = .windows;
    b.installArtifact(exe);
    const run = b.addRunArtifact(exe);
    run.addPassthruArgs();
    b.step("run", "Run the app").dependOn(&run.step);

    const filters = b.option([]const []const u8, "test-filter", "Only run tests whose name contains this") orelse &.{};
    const tests = b.addTest(.{ .filters = filters, .root_module = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "nanoui", .module = nanoui }, .{ .name = "s3", .module = s3 } },
    }) });
    b.step("test", "Run tests against the real MinIO on :9400").dependOn(&b.addRunArtifact(tests).step);
}
