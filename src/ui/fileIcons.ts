// Per-file-type icon mapping for listing rows and drag ghosts. Split out
// from format.ts (a pure string-formatting module, see the jargon sweep
// test) since this one deals in Phosphor icon components instead.
import {
  type Icon,
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
import { isImageName, isVideoName } from "./format";

const PDF_EXT = /\.pdf$/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|m4a)$/i;
const DOC_EXT = /\.(docx?|odt|rtf)$/i;
const XLS_EXT = /\.xlsx?$/i;
const CSV_EXT = /\.csv$/i;
const PPT_EXT = /\.pptx?$/i;
const CODE_EXT = /\.(jsx?|tsx?|py|rs|go|java|c|cpp|sh|json|ya?ml|toml|html|css)$/i;
const TEXT_EXT = /\.(txt|md|log)$/i;

/** Maps a file name's extension to the Phosphor icon that best represents
 * its type, so listing rows and drag ghosts show a recognizable glyph
 * instead of the generic file icon. Falls back to `FileIcon` for anything
 * unmapped (including names with no extension at all). */
export function iconForFileName(name: string): Icon {
  if (PDF_EXT.test(name)) return FilePdfIcon;
  if (ARCHIVE_EXT.test(name)) return FileArchiveIcon;
  if (AUDIO_EXT.test(name)) return FileAudioIcon;
  if (isVideoName(name)) return FilmStripIcon;
  if (DOC_EXT.test(name)) return FileDocIcon;
  if (XLS_EXT.test(name)) return FileXlsIcon;
  if (CSV_EXT.test(name)) return FileCsvIcon;
  if (PPT_EXT.test(name)) return FilePptIcon;
  if (CODE_EXT.test(name)) return FileCodeIcon;
  if (TEXT_EXT.test(name)) return FileTextIcon;
  if (isImageName(name)) return ImageIcon;
  return FileIcon;
}
