export function formatDownloadSize(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  if (bytes < 1024 ** 2) return "< 1 MB";
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
