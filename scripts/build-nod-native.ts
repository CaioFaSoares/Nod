#!/usr/bin/env bun
// Compiles `electrobun/native/NodNative.swift` into the dylib the Electrobun target loads in-process
// (`electrobun/bun/facade/native.ts`). Run by `eb:dev` / `eb:build` before the Electrobun CLI, which
// copies the result into `Resources/app/native/libNodNative.dylib` (see `electrobun.config.ts`).
//
// Usage:
//   bun scripts/build-nod-native.ts                 # host arch
//   bun scripts/build-nod-native.ts --arch=arm64   # release runner per arch
//   bun scripts/build-nod-native.ts --arch=x86_64
//   bun scripts/build-nod-native.ts --arch=universal
//
// The dylib is macOS-only by construction (AppKit/LocalAuthentication/Security). On another host
// this exits 0 with a warning: the tinyjs target never invokes it, and Electrobun's macOS artifacts
// are built on macOS.
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const NATIVE_SOURCE = "electrobun/native/NodNative.swift";
export const NATIVE_OUTPUT = "electrobun/native/build/libNodNative.dylib";

/** Nod's floor (`docs/canonico.md` RNF-01: macOS 15+); Swift would otherwise inherit the runner's SDK. */
export const MACOS_DEPLOYMENT_TARGET = "15.0";

type Arch = "arm64" | "x86_64";

function parseArch(argv: string[]): Arch | "universal" {
    const flag = argv.find((value) => value.startsWith("--arch="));
    if (!flag) return process.arch === "x86_64" ? "x86_64" : "arm64";
    const value = flag.slice("--arch=".length);
    if (value === "arm64" || value === "x86_64" || value === "universal") return value;
    throw new Error(`unknown arch: ${value} (expected arm64, x86_64 or universal)`);
}

function run(command: string[]): void {
    const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
        throw new Error(`${command[0]} failed with exit code ${result.exitCode}`);
    }
}

function compile(source: string, output: string, arch: Arch): void {
    run([
        "swiftc",
        "-O",
        "-swift-version",
        "5",
        "-emit-library",
        "-module-name",
        "NodNative",
        "-target",
        `${arch}-apple-macosx${MACOS_DEPLOYMENT_TARGET}`,
        "-framework",
        "AppKit",
        "-framework",
        "LocalAuthentication",
        "-framework",
        "Security",
        "-framework",
        "UniformTypeIdentifiers",
        // `view.attach`/`views.list` identify the live WKWebView before re-parenting it.
        "-framework",
        "WebKit",
        "-o",
        output,
        source,
    ]);
}

export function buildNodNative(options: { arch?: Arch | "universal"; rootDir?: string } = {}): string {
    const rootDir = resolve(options.rootDir ?? process.cwd());
    const source = join(rootDir, NATIVE_SOURCE);
    const output = join(rootDir, NATIVE_OUTPUT);
    const arch = options.arch ?? (process.arch === "x86_64" ? "x86_64" : "arm64");

    if (process.platform !== "darwin") {
        console.warn(`build-nod-native: skipped (swiftc/AppKit are macOS-only; host is ${process.platform})`);
        return output;
    }
    if (!existsSync(source)) {
        throw new Error(`missing ${source}`);
    }
    if (!Bun.which("swiftc")) {
        throw new Error("swiftc not found; install Xcode Command Line Tools (xcode-select --install)");
    }

    const buildDir = join(rootDir, "electrobun/native/build");
    mkdirSync(buildDir, { recursive: true });

    if (arch !== "universal") {
        compile(source, output, arch);
        return output;
    }

    const temporary = [
        join(buildDir, `.libNodNative-arm64.dylib`),
        join(buildDir, `.libNodNative-x86_64.dylib`),
    ];
    try {
        compile(source, temporary[0]!, "arm64");
        compile(source, temporary[1]!, "x86_64");
        run(["lipo", "-create", "-output", output, ...temporary]);
    } finally {
        for (const path of temporary) {
            if (existsSync(path)) rmSync(path);
        }
    }
    return output;
}

if (import.meta.main) {
    const arch = parseArch(process.argv.slice(2));
    const output = buildNodNative({ arch });
    const size = existsSync(output) ? statSync(output).size : 0;
    console.log(`build-nod-native: ${arch} → ${NATIVE_OUTPUT} (${(size / 1024).toFixed(0)} KiB)`);
}
