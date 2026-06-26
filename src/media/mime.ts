const EXT_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
};

export function getExtensionFromContentTypeOrUrl(
  contentType: string | null,
  url: string,
): string {
  if (contentType) {
    const mapped = Object.entries(EXT_MAP).find(
      ([, mime]) => mime === contentType.split(";")[0]?.trim(),
    );
    if (mapped) return mapped[0];
  }
  const urlPath = url.split("?")[0] ?? url;
  const dotIdx = urlPath.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = urlPath.slice(dotIdx).toLowerCase();
    if (ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext)) return ext;
  }
  return ".bin";
}

export function mimeFromFilename(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = filename.slice(dotIdx).toLowerCase();
    return EXT_MAP[ext] ?? "application/octet-stream";
  }
  return "application/octet-stream";
}
