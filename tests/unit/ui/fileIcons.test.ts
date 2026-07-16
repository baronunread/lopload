import { describe, expect, test } from "bun:test";
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileDocIcon,
  FileIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileXlsIcon,
  FilmStripIcon,
  ImageIcon,
} from "@phosphor-icons/react";
import { iconForFileName } from "../../../src/ui/fileIcons";

describe("iconForFileName", () => {
  test("maps each extension group to its Phosphor icon", () => {
    const cases: Array<[string, unknown]> = [
      ["report.pdf", FilePdfIcon],
      ["archive.zip", FileArchiveIcon],
      ["archive.rar", FileArchiveIcon],
      ["archive.7z", FileArchiveIcon],
      ["archive.tar", FileArchiveIcon],
      ["archive.gz", FileArchiveIcon],
      ["archive.bz2", FileArchiveIcon],
      ["archive.xz", FileArchiveIcon],
      ["song.mp3", FileAudioIcon],
      ["song.wav", FileAudioIcon],
      ["song.flac", FileAudioIcon],
      ["song.aac", FileAudioIcon],
      ["song.ogg", FileAudioIcon],
      ["song.m4a", FileAudioIcon],
      ["clip.mp4", FilmStripIcon],
      ["clip.mov", FilmStripIcon],
      ["clip.webm", FilmStripIcon],
      ["essay.doc", FileDocIcon],
      ["essay.docx", FileDocIcon],
      ["essay.odt", FileDocIcon],
      ["essay.rtf", FileDocIcon],
      ["sheet.xls", FileXlsIcon],
      ["sheet.xlsx", FileXlsIcon],
      ["data.csv", FileCsvIcon],
      ["deck.ppt", FilePptIcon],
      ["deck.pptx", FilePptIcon],
      ["main.js", FileCodeIcon],
      ["main.jsx", FileCodeIcon],
      ["main.ts", FileCodeIcon],
      ["main.tsx", FileCodeIcon],
      ["script.py", FileCodeIcon],
      ["lib.rs", FileCodeIcon],
      ["main.go", FileCodeIcon],
      ["Main.java", FileCodeIcon],
      ["prog.c", FileCodeIcon],
      ["prog.cpp", FileCodeIcon],
      ["run.sh", FileCodeIcon],
      ["data.json", FileCodeIcon],
      ["config.yaml", FileCodeIcon],
      ["config.yml", FileCodeIcon],
      ["config.toml", FileCodeIcon],
      ["index.html", FileCodeIcon],
      ["style.css", FileCodeIcon],
      ["notes.txt", FileTextIcon],
      ["notes.md", FileTextIcon],
      ["app.log", FileTextIcon],
      ["photo.png", ImageIcon],
      ["photo.jpg", ImageIcon],
      ["photo.jpeg", ImageIcon],
      ["photo.gif", ImageIcon],
      ["photo.webp", ImageIcon],
      ["photo.svg", ImageIcon],
    ];

    for (const [name, icon] of cases) {
      expect(iconForFileName(name)).toBe(icon);
    }
  });

  test("is case-insensitive on the extension", () => {
    expect(iconForFileName("REPORT.PDF")).toBe(FilePdfIcon);
    expect(iconForFileName("Archive.ZIP")).toBe(FileArchiveIcon);
    expect(iconForFileName("Clip.MP4")).toBe(FilmStripIcon);
  });

  test("falls back to the generic file icon for unmapped or missing extensions", () => {
    expect(iconForFileName("weird.xyz")).toBe(FileIcon);
    expect(iconForFileName("no-extension")).toBe(FileIcon);
    expect(iconForFileName("")).toBe(FileIcon);
  });
});
